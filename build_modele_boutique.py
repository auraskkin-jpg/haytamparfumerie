from __future__ import annotations

import hashlib
import html
import json
import re
import shutil
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "modele-boutique"
RASTER_IMAGES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"}
VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
PLACEHOLDER_STYLE = """
<style>
.template-image-placeholder{box-sizing:border-box;display:grid;place-items:center;overflow:hidden;border:1px dashed #e4c4bf;background:repeating-linear-gradient(135deg,#fffaf9,#fffaf9 14px,#f9eeeb 14px,#f9eeeb 28px);color:#8b716d;font:12px/1.4 sans-serif;text-align:center;padding:8px;max-width:100%}
.media .template-image-placeholder,.hp-bslider__slide .template-image-placeholder,.collection-banner-tile .template-image-placeholder{position:absolute;inset:0;width:100%;height:100%;min-height:0}
.header__heading-logo.template-image-placeholder{display:grid;width:120px;height:69px}
.bd-logo .template-image-placeholder{height:24px;min-width:80px}
</style>
"""
BLOCKED_SCRIPT_MARKERS = (
    "window.shopify", "shopifyanalytics", "shopifycdn.com", "cdn.shopify.com",
    "shopify", "webmcp", "gtag(", "google-analytics", "judge.me", "pushdaddy",
    "paypal", "api/collect", "xmlhttprequest", "fetch(", "axios.", "recaptcha",
    "wwhatsapp", "pdaddy", "blantershow-chat",
)
TEXT_SUFFIXES = {".html", ".htm", ".css", ".js", ".json", ".txt", ".xml", ".svg", ".md"}
BRAND_URL = re.compile(r"(?:https?:)?(?:\\?/){2}(?:www\.)?haytamparfumerie\.com(?P<path>(?:\\?/)[^\s\"'<>,)]*)?", re.I)
BRAND_HOST = re.compile(r"(?:www\.)?haytamparfumerie\.com", re.I)
BRAND_HANDLE = re.compile(r"haytamparfumerie", re.I)
BRAND_UNDERSCORE = re.compile(r"haytam_parfumerie", re.I)
BRAND_SPACED = re.compile(r"haytam(?:\s*-\s*|\s*<em>\s*|\s+)parfumerie(?:\s*</em>)?", re.I)
BRAND_WORD = re.compile(r"\bhaytam\b", re.I)
CMS_TEXT_TAGS = {"h1", "h2", "h3", "h4", "p", "span", "a"}
CMS_BLOCKED_CONTEXT = ("card", "product", "cod-", "drawer", "cart", "menu", "facet", "collection")
CMS_TEXTS: dict[str, dict] = {}
CMS_IMAGES: list[dict] = []
CMS_NAV: dict[str, dict] = {}
BLANK_TARGET_LINK = re.compile(r'<a\b(?=[^>]*\btarget="_blank")(?![^>]*\brel=)[^>]*', re.I)
BLOCKED_SCRIPT_FILES = (
    "cart.js", "cart-notification.js", "product-form.js", "product-info.js",
    "predictive-search.js", "facets.js", "search-form.js", "quick-order-list.js",
    "cod-cart-drawer.js", "cod-popup.js", "preloads.js",
)


class HTMLScanner(HTMLParser):
    def __init__(self, source: str):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.line_offsets = [0]
        for line in source.splitlines(keepends=True):
            self.line_offsets.append(self.line_offsets[-1] + len(line))
        self.nodes: list[dict] = []
        self.stack: list[dict] = []

    def source_offset(self) -> int:
        line, column = self.getpos()
        return self.line_offsets[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.add_node(tag, attrs, self.get_starttag_text(), self_closing=False)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.add_node(tag, attrs, self.get_starttag_text(), self_closing=True)

    def add_node(self, tag: str, attrs: list[tuple[str, str | None]], raw: str, self_closing: bool) -> None:
        start = self.source_offset()
        node = {
            "tag": tag.lower(),
            "attrs": {key.lower(): value for key, value in attrs},
            "start": start,
            "open_end": start + len(raw),
            "end": start + len(raw),
            "close_start": start + len(raw),
            "raw": raw,
            "parent": self.stack[-1] if self.stack else None,
        }
        self.nodes.append(node)
        if not self_closing and tag.lower() not in VOID_TAGS:
            self.stack.append(node)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                position = self.source_offset()
                for node in self.stack[index:]:
                    node["close_start"] = position
                    node["end"] = position + len(tag) + 3 if node["tag"] == tag else position
                del self.stack[index:]
                return


def classes(node: dict) -> set[str]:
    return set((node["attrs"].get("class") or "").split())


def ancestors(node: dict):
    parent = node["parent"]
    while parent:
        yield parent
        parent = parent["parent"]


def is_cms_page(relative: str) -> bool:
    return relative in {"index.html", "cart.html"} or relative.startswith(("pages/", "policies/", "blogs/"))


def in_cms_blocked_context(node: dict) -> bool:
    for item in [node, *ancestors(node)]:
        if item["tag"] in {"html", "body"}:
            continue
        if any(word in token for token in classes(item) for word in CMS_BLOCKED_CONTEXT):
            return True
    return False


def plain_text(fragment: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def cms_text_key(text: str) -> str:
    return "t:" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def in_nav_menu(node: dict) -> bool:
    return any(token == "bd-nav" for item in [node, *ancestors(node)] for token in classes(item))


def nav_item(node: dict, source: str) -> tuple[str, str, str]:
    href = node["attrs"].get("href") or ""
    text = plain_text(source[node["open_end"]:node["close_start"]])
    group = ""
    for ancestor in ancestors(node):
        if ancestor["tag"] == "li" and "bd-dropdown" in classes(ancestor):
            match = re.search(r"<button[^>]*>(.*?)</button>", source[ancestor["open_end"]:ancestor["close_start"]], flags=re.S | re.I)
            group = plain_text(match.group(1)) if match else ""
            break
    key = "nav:" + hashlib.sha1(f"{href}|{text}".encode("utf-8")).hexdigest()[:12]
    name = f"{group} › {text}" if group and group != text else text
    return key, name, text


def add_tag_attribute(replacements: list, node: dict, name: str, value: str) -> None:
    for index, (start, end, text) in enumerate(replacements):
        if start == node["start"] and end == node["open_end"]:
            if text.endswith(">"):
                replacements[index] = (start, end, replace_attribute(text, name, value))
            return
    replacements.append((node["start"], node["open_end"], replace_attribute(node["raw"], name, value)))


def write_cms_slots() -> None:
    texts = [
        {"key": key, "default": value["default"], "pages": sorted(value["pages"])}
        for key, value in sorted(CMS_TEXTS.items(), key=lambda item: item[1]["default"].lower())
    ]
    nav_images = [
        {"key": key, "page": "menu", "label": "Menu", "name": value["name"], "index": index}
        for index, (key, value) in enumerate(CMS_NAV.items(), start=1)
    ]
    payload = {"texts": texts, "images": CMS_IMAGES + nav_images}
    (OUTPUT / "cms-slots.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")


def replace_attribute(tag_text: str, name: str, value: str) -> str:
    pattern = rf"(\b{re.escape(name)}\s*=\s*)(['\"])(.*?)\2"
    escaped = html.escape(value, quote=True)
    if re.search(pattern, tag_text, flags=re.I | re.S):
        return re.sub(pattern, lambda match: match.group(1) + match.group(2) + escaped + match.group(2), tag_text, count=1, flags=re.I | re.S)
    return tag_text[:-1] + f' {name}="{escaped}">'


def relative_store_link(value: str, page: Path) -> str | None:
    parsed = urlsplit(value)
    if parsed.hostname not in {"haytamparfumerie.com", "www.haytamparfumerie.com"}:
        return None
    target = unquote(parsed.path).lstrip("/")
    if not target:
        target = "index.html"
    elif target.endswith("/"):
        target += "index.html"
    elif not Path(target).suffix and (OUTPUT / target / "index.html").is_file():
        target += "/index.html"
    elif not Path(target).suffix:
        target += ".html"
    if parsed.query and target.endswith("/vendors.html"):
        target = target[:-5] + "?" + parsed.query + ".html"
    relative = Path(shutil.os.path.relpath(OUTPUT / target, page.parent))
    return relative.as_posix()


def should_remove_script(node: dict, inner: str) -> bool:
    attrs = node["attrs"]
    source = attrs.get("src") or ""
    script_type = (attrs.get("type") or "").lower()
    attribution = (attrs.get("data-source-attribution") or "").lower()
    identifier = (attrs.get("id") or "").lower()
    lower_source = source.lower()
    if source:
        if lower_source.startswith(("http://", "https://", "//")):
            return True
        if "shopifycloud" in lower_source or "shopify.com" in lower_source:
            return True
        if any(name in lower_source for name in BLOCKED_SCRIPT_FILES):
            return True
    if "shopify" in attribution or "shopify" in identifier or script_type in {"application/json", "application/ld+json"}:
        return True
    text = re.sub(r"\\/", "/", inner.lower())
    return any(marker in text for marker in BLOCKED_SCRIPT_MARKERS)


SOCIAL_LINKS = [
    (
        "Instagram",
        "https://www.instagram.com/auraskin_by_chayy/",
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>',
    ),
    (
        "Facebook",
        "https://www.facebook.com/share/1Hs6KmZEPU/",
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 21v-8h2.7l.4-3h-3.1V8.1c0-.9.3-1.6 1.6-1.6h1.7V3.8c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3V10H7.3v3h2.8v8h3.4z"/></svg>',
    ),
    (
        "TikTok",
        "https://www.tiktok.com/@auraskin_by_chayy",
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.6 8.3a7.1 7.1 0 0 1-4.4-1.5v7.4a5.9 5.9 0 1 1-5.9-5.9c.4 0 .8 0 1.2.1v3.3a2.7 2.7 0 1 0 1.8 2.5V2.5h3.2a7.1 7.1 0 0 0 4.1 4.6v3.3z"/></svg>',
    ),
    (
        "WhatsApp",
        "https://wa.me/212727707993",
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a9.7 9.7 0 0 0-8.3 14.8L2.4 22l5.4-1.4A9.8 9.8 0 1 0 12 2zm0 17.7a8 8 0 0 1-4.1-1.1l-.3-.2-3.2.8.9-3.1-.2-.3A8 8 0 1 1 12 19.7zm4.4-6c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1-.6.8-.8.9-.3.2-.5.1a6.5 6.5 0 0 1-1.9-1.2 7.1 7.1 0 0 1-1.3-1.6c-.1-.2 0-.3.1-.4l.4-.5.2-.4v-.4c0-.1-.5-1.3-.7-1.8-.2-.5-.4-.4-.5-.4h-.5c-.2 0-.4.1-.6.3s-.8.8-.8 1.9.8 2.2.9 2.3a9.1 9.1 0 0 0 3.5 3.1c.5.2.9.4 1.2.5.5.1.9.1 1.2.1.4-.1 1.4-.6 1.6-1.1s.2-1 .2-1.1-.2-.2-.4-.3z"/></svg>',
    ),
]


def social_markup(container_class: str) -> str:
    anchors = []
    for label, url, icon in SOCIAL_LINKS:
        anchors.append(
            f'<a class="{"hp-social-icon" if container_class == "hp-social-container" else "social-link"}" '
            f'href="{url}" target="_blank" rel="noopener noreferrer" aria-label="{label}" title="{label}">{icon}</a>'
        )
    return f'<div class="{container_class}">{"".join(anchors)}</div>'


def social_page_markup() -> str:
    rows = []
    for label, url, icon in SOCIAL_LINKS:
        rows.append(
            f'<li><a href="{url}" target="_blank" rel="noopener noreferrer" aria-label="Ouvrir {label}">'
            f'<span class="hp-icon">{icon}</span><span class="hp-text">{label}</span>'
            '<svg class="hp-open-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>'
            '</a></li>'
        )
    return (
        '<style>'
        '.hp-social-only{width:min(94%,560px);margin:2vh auto 4vh;padding:32px 26px;background:#fff;border:1px solid #eadbd7;border-radius:4px;box-shadow:0 12px 36px rgba(67,43,40,.08)}'
        '.hp-brand-link{display:block;width:min(240px,72%);margin:0 auto 18px}.hp-social-only .hp-logo{display:block;width:100%;height:auto;margin:0}'
        '.hp-social-only h1{margin:0;color:#211a19;font:400 clamp(23px,5vw,32px)/1.2 Georgia,serif}.hp-social-intro{margin:10px 0 20px;color:#786866;font:13px/1.5 sans-serif}'
        '.hp-social-only ul.hp-links{display:grid;gap:10px;margin:0;padding:0;list-style:none}.hp-social-only ul.hp-links li{margin:0;padding:5px;border:1px solid #ead4d0;border-radius:4px;background:linear-gradient(110deg,#f9e8e5,#fff9f8);box-shadow:none;transition:transform .18s ease,background .18s ease}'
        '.hp-social-only ul.hp-links li:hover{transform:translateY(-2px);background:#f4dfdc}.hp-social-only ul.hp-links li a{min-height:54px;color:#302624}.hp-social-only .hp-icon{width:44px;height:44px;flex:none;margin-right:12px;background:#fff}.hp-social-only .hp-icon svg{width:23px;height:23px;color:#815752}.hp-social-only .hp-text{color:#302624;font:600 14px/1.3 sans-serif}.hp-social-only .hp-open-icon{width:18px;height:18px;margin:0 12px;color:#8e625d}'
        '@media(max-width:480px){.hp-social-only{padding:25px 18px}.hp-social-only ul.hp-links li a{min-height:50px}}'
        '</style>'
        '<main class="hp-container hp-social-only">'
        '<a class="hp-brand-link" href="../index.html" aria-label="Aura Skin by Chayy, accueil">'
        '<img class="hp-logo" src="../assets/aura-skin-logo.svg" alt="Aura Skin by Chayy">'
        '</a>'
        '<h1>Retrouve-nous sur nos réseaux</h1>'
        '<p class="hp-social-intro">Suis Aura Skin by Chayy et contacte-nous.</p>'
        f'<ul class="hp-links">{"".join(rows)}</ul>'
        '</main>'
    )


def remove_physical_contact_rows(source: str) -> str:
    scanner = HTMLScanner(source)
    scanner.feed(source)
    removals = []
    for node in scanner.nodes:
        if node["tag"] != "li" or not node["parent"] or "hpf-contact" not in classes(node["parent"]):
            continue
        content = source[node["open_end"]:node["close_start"]]
        if "tel:" in content.lower() or re.search(r"\b(rue|avenue|boulevard|adresse|tanger)\b", re.sub(r"<[^>]+>", " ", content), flags=re.I):
            removals.append((node["start"], node["end"]))
    for start, end in reversed(removals):
        source = source[:start] + source[end:]
    return source


def transform_html(path: Path) -> None:
    source = path.read_text(encoding="utf-8", errors="replace")
    source = remove_physical_contact_rows(source)
    if path.relative_to(OUTPUT).as_posix() == "pages/faq.html":
        source = re.sub(
            r'<div class="faq-section">\s*<h2>Puis-je récupérer ma commande en magasin\?</h2>\s*<p>[\s\S]*?</p>\s*</div>',
            "",
            source,
            count=1,
            flags=re.I,
        )
        source = re.sub(
            r'<div class="faq-section">\s*<h2>Quels sont les horaires de retrait en magasin\?</h2>\s*<p>[\s\S]*?</p>\s*</div>',
            "",
            source,
            count=1,
            flags=re.I,
        )
        source = re.sub(
            r'(<h1>FAQ\s*-\s*Livraison et Commandes</h1>)',
            r'\1<p class="faq-online-note">Aura Skin est une boutique en ligne. Les commandes se font sur le site et sont livrées à l’adresse indiquée; aucun retrait sur place n’est proposé.</p>',
            source,
            count=1,
            flags=re.I,
        )
    if path.relative_to(OUTPUT).as_posix() == "pages/social-media.html":
        scanner = HTMLScanner(source)
        scanner.feed(source)
        for node in scanner.nodes:
            if node["tag"] == "div" and "hp-container" in classes(node):
                source = source[:node["start"]] + social_page_markup() + source[node["end"]:]
                break
        source = re.sub(
            r'<a\s+href="https://www\.instagram\.com/abdlmalk_douiyeb/"[^>]*>AD Designs</a>',
            "AD Designs",
            source,
            flags=re.I,
        )
        source = re.sub(r"<title>[\s\S]*?</title>", "<title>Aura Skin | Réseaux sociaux</title>", source, count=1, flags=re.I)
        source = re.sub(
            r'(<meta\s+name="description"\s+content=")[^"]*(">)',
            r'\1Retrouve Aura Skin by Chayy sur Instagram, Facebook, TikTok et WhatsApp.\2',
            source,
            count=1,
            flags=re.I,
        )
    source = re.sub(r'<div class="bd-social">[\s\S]*?</div>', lambda _: social_markup("bd-social"), source, flags=re.I)
    source = re.sub(r'<div class="hp-social-container">[\s\S]*?</div>', lambda _: social_markup("hp-social-container"), source, flags=re.I)
    source = re.sub(
        r"<!--\s*BEGIN app block:\s*shopify://apps/(?:pushdaddy|judge-me)[\s\S]*?<!--\s*END app block\s*-->",
        "",
        source,
        flags=re.I,
    )
    scanner = HTMLScanner(source)
    scanner.feed(source)
    replacements: list[tuple[int, int, str]] = []
    is_product_page = "products" in path.relative_to(OUTPUT).parts
    is_collection_page = "collections" in path.relative_to(OUTPUT).parts
    relative_page = path.relative_to(OUTPUT).as_posix()
    cms_page = is_cms_page(relative_page)
    cms_image_index = 0
    cms_last_heading = ""

    for node in scanner.nodes:
        tag = node["tag"]
        attrs = node["attrs"]
        raw = node["raw"]
        node_classes = classes(node)
        lower_raw = raw.lower()

        if cms_page and tag in {"h1", "h2", "h3", "h4"} and not in_cms_blocked_context(node):
            heading = plain_text(source[node["open_end"]:node["close_start"]])
            if heading:
                cms_last_heading = heading

        if "blantershow-chat" in node_classes or "shopify-app-block" in node_classes or "hpf-whatsapp" in node_classes:
            replacements.append((node["start"], node["end"], ""))
            continue

        if tag in {"img", "source"}:
            if tag == "source":
                replacements.append((node["start"], node["end"], ""))
                continue
            parent_classes = [classes(parent) for parent in ancestors(node)]
            is_store_logo = (
                "header__heading-logo" in node_classes
                or "hpf-logo-img" in node_classes
                or "hp-logo" in node_classes
                or any("bd-logo" in parent_class or "hpf-logo" in parent_class for parent_class in parent_classes)
            )
            if is_store_logo:
                logo_path = Path(shutil.os.path.relpath(OUTPUT / "assets/aura-skin-logo.svg", path.parent)).as_posix()
                if "hpf-logo-img" in node_classes:
                    logo_style = "width:min(190px,100%);height:52px;object-fit:contain"
                elif any("bd-logo" in parent_class for parent_class in parent_classes):
                    logo_style = "width:150px;height:40px;object-fit:contain"
                else:
                    logo_style = "width:min(190px,32vw);height:62px;object-fit:contain"
                logo = (
                    f'<img src="{html.escape(logo_path, quote=True)}" alt="Aura Skin by Chayy" '
                    f'class="{html.escape(attrs.get("class") or "store-logo", quote=True)}" '
                    f'style="{logo_style}" loading="eager" decoding="async">'
                )
                replacements.append((node["start"], node["end"], logo))
                continue
            in_media = any(
                "media" in classes(parent)
                or "collection-banner-tile" in classes(parent)
                or "hp-bslider__slide" in classes(parent)
                for parent in ancestors(node)
            )
            width = attrs.get("width")
            height = attrs.get("height")
            style = ""
            if not in_media and width and height and width.isdigit() and height.isdigit():
                style = f' style="width:min({width}px,100%);height:auto;aspect-ratio:{width}/{height}"'
            label = "Logo à ajouter" if "logo" in (attrs.get("alt") or "").lower() or "logo" in " ".join(node_classes).lower() else "Image à ajouter"
            class_value = "template-image-placeholder " + (attrs.get("class") or "")
            cms_attribute = ""
            if cms_page and not in_cms_blocked_context(node):
                cms_image_index += 1
                cms_key = f"{relative_page}#{cms_image_index}"
                name = ""
                for ancestor in ancestors(node):
                    if ancestor["tag"] == "a":
                        name = plain_text(source[ancestor["open_end"]:ancestor["close_start"]])
                        break
                if not name and any("hp-bslider" in token for item in [node, *ancestors(node)] for token in classes(item)):
                    name = "Bannière de l'accueil"
                if not name and any("logo" in token for item in [node, *ancestors(node)] for token in classes(item)):
                    name = "Logo"
                name = (name or cms_last_heading or "Photo")[:80]
                CMS_IMAGES.append({"key": cms_key, "page": relative_page, "label": label, "name": name, "index": cms_image_index})
                cms_attribute = f' data-cms-image="{html.escape(cms_key, quote=True)}"'
            placeholder = f'<span class="{html.escape(class_value, quote=True)}" aria-label="{label}"{style}{cms_attribute}>{label}</span>'
            replacements.append((node["start"], node["end"], placeholder))
            continue

        if tag == "script":
            inner = source[node["open_end"]:node["close_start"]]
            if "hp-bslider-radio" in inner and "setInterval" in inner:
                replacements.append((node["start"], node["end"], ""))
                continue
            if should_remove_script(node, inner):
                replacements.append((node["start"], node["end"], ""))
                continue

        if tag == "link":
            relation = (attrs.get("rel") or "").lower()
            href = attrs.get("href") or ""
            if "cdn.shopify.com/extensions" in href.lower():
                replacements.append((node["start"], node["end"], ""))
                continue
            if relation == "canonical" or relation in {"preconnect", "dns-prefetch"} and "shopify" in href.lower():
                replacements.append((node["start"], node["end"], ""))
                continue
            if "haytamparfumerie.com" in href.lower() and any(key in relation for key in ("icon", "image")):
                replacements.append((node["start"], node["end"], ""))
                continue
            if urlsplit(href).scheme in {"http", "https"} or href.startswith("//"):
                replacements.append((node["start"], node["end"], ""))
                continue

        if tag == "meta":
            key = " ".join(str(attrs.get(name) or "") for name in ("name", "property", "http-equiv")).lower()
            if "image" in key or "verification" in key or "shopify" in key:
                replacements.append((node["start"], node["end"], ""))
                continue
            content = attrs.get("content") or ""
            if attrs.get("property", "").lower() in {"og:url", "og:image", "og:image:secure_url"} or content.startswith(("http://", "https://")):
                replacements.append((node["start"], node["end"], ""))
                continue
            if attrs.get("name", "").lower() == "description" and (is_product_page or is_collection_page):
                replacements.append((node["start"], node["end"], replace_attribute(raw, "content", "Description à ajouter")))
                continue

        if tag == "style" and "data-shopify" in lower_raw:
            replacements.append((node["start"], node["open_end"], re.sub(r"\sdata-shopify(?:\s*=\s*(['\"]).*?\1)?", "", raw, flags=re.I)))

        if cms_page and tag in CMS_TEXT_TAGS and not in_cms_blocked_context(node):
            inner = source[node["open_end"]:node["close_start"]]
            text = " ".join(html.unescape(inner).split())
            if inner and "<" not in inner and 2 <= len(text) <= 400:
                cms_key = cms_text_key(text)
                entry = CMS_TEXTS.setdefault(cms_key, {"default": text, "pages": set()})
                entry["pages"].add(relative_page)
                add_tag_attribute(replacements, node, "data-cms-text", cms_key)

        if tag == "form":
            disabled_form = replace_attribute(raw, "action", "#")
            replacements.append((node["start"], node["open_end"], replace_attribute(disabled_form, "onsubmit", "return false;")))
            continue

        if tag == "iframe":
            replacements.append((node["start"], node["end"], ""))
            continue

        if "header__icon--account" in node_classes:
            login_tag = re.sub(r"\s+small-hide\b", "", replace_attribute(raw, "href", "/login"))
            replacements.append((node["start"], node["open_end"], login_tag))
            continue

        if tag == "a" and attrs.get("href"):
            if attrs["href"].startswith("customer_authentication/"):
                replacements.append((node["start"], node["open_end"], replace_attribute(raw, "href", "/login")))
            if "hpf-whatsapp" in node_classes:
                replacements.append((node["start"], node["open_end"], replace_attribute(raw, "href", "https://wa.me/212727707993")))
            relative = relative_store_link(attrs["href"], path)
            if relative:
                replacements.append((node["start"], node["open_end"], replace_attribute(raw, "href", relative)))
            if "hpf-logo" in node_classes:
                replacements.append((node["start"], node["open_end"], replace_attribute(raw, "aria-label", "Aura Skin by Chayy, accueil")))

        replace_inner_with = None
        if "card__heading" in node_classes:
            inner = source[node["open_end"]:node["close_start"]]
            anchor = re.search(r"(<a\b[^>]*>).*?(</a>)", inner, flags=re.I | re.S)
            replace_inner_with = anchor.group(1) + "Nom du produit" + anchor.group(2) if anchor else "Nom du produit"
        elif is_product_page and tag in {"h1", "h2"} and any("product__title" in classes(parent) for parent in ancestors(node)):
            replace_inner_with = "Nom du produit"
        elif "product__description" in node_classes:
            replace_inner_with = "<p>Description à ajouter</p>"
        elif "collection-hero__description" in node_classes:
            replace_inner_with = "<p>Description de la collection à ajouter</p>"
        elif "product__vendor" in node_classes or "vendor-image" in node_classes:
            replace_inner_with = "Marque à ajouter"
        elif "price-item" in node_classes:
            replace_inner_with = "Prix à ajouter"
        elif "hpf-logo-word" in node_classes:
            replace_inner_with = "AURA SKIN"
        elif is_product_page and tag == "title":
            replace_inner_with = "Produit | Votre boutique"

        if replace_inner_with is not None and node["close_start"] > node["open_end"]:
            replacements.append((node["open_end"], node["close_start"], replace_inner_with))

    closing_head = re.search(r"</head\s*>", source, flags=re.I)
    if closing_head:
        replacements.append((closing_head.start(), closing_head.start(), PLACEHOLDER_STYLE))

    for node in scanner.nodes:
        if node["tag"] in {"a", "button"} and in_nav_menu(node):
            nav_key, nav_name, nav_text = nav_item(node, source)
            if nav_text:
                CMS_NAV.setdefault(nav_key, {"name": nav_name})
                add_tag_attribute(replacements, node, "data-cms-image", nav_key)

    replacements.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    filtered: list[tuple[int, int, str]] = []
    right_edge = -1
    for replacement in replacements:
        start, end, _ = replacement
        if start < right_edge:
            continue
        filtered.append(replacement)
        right_edge = max(right_edge, end)

    for start, end, replacement in reversed(filtered):
        source = source[:start] + replacement + source[end:]
    path.write_text(source, encoding="utf-8")


def add_local_runtime(path: Path) -> None:
    source = path.read_text(encoding="utf-8", errors="replace")
    runtime_path = Path(shutil.os.path.relpath(OUTPUT / "boutique-runtime.js", path.parent)).as_posix()
    script_tag = f'<script src="{html.escape(runtime_path, quote=True)}" defer></script>'
    is_homepage = "hp-bslider-radio1" in source
    brand_path = Path(shutil.os.path.relpath(OUTPUT / "boutique-brand.css", path.parent)).as_posix()
    motion_assets = f'<link rel="stylesheet" href="{html.escape(brand_path, quote=True)}">'
    if is_homepage:
        style_path = Path(shutil.os.path.relpath(OUTPUT / "boutique-motion.css", path.parent)).as_posix()
        motion_path = Path(shutil.os.path.relpath(OUTPUT / "boutique-motion.js", path.parent)).as_posix()
        motion_assets += f'<link rel="stylesheet" href="{html.escape(style_path, quote=True)}">'
        script_tag += f'<script src="{html.escape(motion_path, quote=True)}" defer></script>'
    closing_head = re.search(r"</head\s*>", source, flags=re.I)
    if closing_head and motion_assets:
        source = source[:closing_head.start()] + motion_assets + source[closing_head.start():]
    closing_body = re.search(r"</body\s*>", source, flags=re.I)
    if closing_body:
        source = source[:closing_body.start()] + script_tag + source[closing_body.start():]
        path.write_text(source, encoding="utf-8")


def ignore_copy(directory: str, names: list[str]) -> set[str]:
    current = Path(directory)
    ignored = set()
    for name in names:
        item = current / name
        relative = item.relative_to(ROOT)
        if relative.parts[0] in {"modele-boutique", "backend", "checkouts", ".well-known", "__pycache__", "build_modele_boutique.py"}:
            ignored.add(name)
        elif item.is_file() and item.suffix.lower().startswith(".js") and any(blocked in item.name.lower() for blocked in BLOCKED_SCRIPT_FILES):
            ignored.add(name)
        elif item.is_file() and relative.parts[:2] == ("cdn", "shopifycloud") and item.suffix.lower() not in {".css", ".woff", ".woff2", ".ttf"}:
            ignored.add(name)
        elif item.suffix.lower() in RASTER_IMAGES and relative.parts[:2] != ("assets", "products"):
            ignored.add(name)
    return ignored


def normalize_local_assets() -> None:
    for path in list(OUTPUT.rglob("*")):
        if not path.is_file() or "?" not in path.name:
            continue
        target = path.with_name(path.name.split("?", 1)[0])
        if target.exists():
            path.unlink()
        else:
            path.rename(target)

    for path in OUTPUT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".html", ".css"}:
            continue
        source = path.read_text(encoding="utf-8", errors="replace")
        normalized = re.sub(r"%3[fF][^\"'\s<>)]*", "", source)
        if normalized != source:
            path.write_text(normalized, encoding="utf-8")


def replace_brand_word(match: re.Match[str]) -> str:
    text = match.group(0)
    if text.isupper():
        return "AURA SKIN"
    if text[0].isupper():
        return "Aura Skin"
    return "aura-skin"


def local_target_exists(path: str) -> bool:
    clean = unquote(path.replace("\\/", "/")).split("?", 1)[0].split("#", 1)[0].lstrip("/")
    if not clean:
        return True
    target = OUTPUT / clean
    return target.is_file() or (target / "index.html").is_file() or target.with_name(target.name + ".html").is_file()


def add_noopener(source: str) -> str:
    return BLANK_TARGET_LINK.sub(lambda match: match.group(0)[:2] + ' rel="noopener noreferrer"' + match.group(0)[2:], source)


def rebrand_text(source: str, suffix: str) -> str:
    source = add_noopener(source)
    if suffix in {".txt", ".xml"}:
        source = BRAND_URL.sub("https://aura-skin.com", source)
        kept: list[str] = []
    else:
        kept = []

        def keep_or_localize(match: re.Match[str]) -> str:
            path = match.group("path") or ""
            if local_target_exists(path):
                return path
            kept.append(match.group(0))
            return f"\0{len(kept) - 1}\0"

        source = BRAND_URL.sub(keep_or_localize, source)
    source = BRAND_HOST.sub("aura-skin.com", source)
    source = BRAND_HANDLE.sub("aura-skin", source)
    source = BRAND_UNDERSCORE.sub("aura_skin", source)
    source = BRAND_SPACED.sub(replace_brand_word, source)
    source = BRAND_WORD.sub(replace_brand_word, source)
    return re.sub(r"\0(\d+)\0", lambda match: kept[int(match.group(1))], source)


def rebrand_output() -> None:
    for path in OUTPUT.rglob("*"):
        if not path.is_file() or (path.suffix and path.suffix.lower() not in TEXT_SUFFIXES):
            continue
        source = path.read_text(encoding="utf-8", errors="replace")
        if "\0" in source:
            continue
        rebranded = rebrand_text(source, path.suffix.lower())
        if rebranded != source:
            path.write_text(rebranded, encoding="utf-8")


def disable_data_loaders() -> None:
    for script_path in OUTPUT.rglob("global.js*"):
        script = script_path.read_text(encoding="utf-8", errors="replace")
        quick_order_start = script.find("class BulkModal extends HTMLElement{")
        quick_order_end = script.find('customElements.define("bulk-modal",BulkModal);', quick_order_start)
        if quick_order_start >= 0 and quick_order_end >= 0:
            quick_order_end += len('customElements.define("bulk-modal",BulkModal);')
            script = script[:quick_order_start] + 'class BulkModal extends HTMLElement{connectedCallback(){}}customElements.define("bulk-modal",BulkModal);' + script[quick_order_end:]

        recommendations_start = script.find("loadRecommendations(productId){")
        recommendations_end = script.find('}}customElements.define("product-recommendations",ProductRecommendations);', recommendations_start)
        if recommendations_start >= 0 and recommendations_end >= 0:
            script = script[:recommendations_start] + "loadRecommendations(){}" + script[recommendations_end + 1:]
        script_path.write_text(script, encoding="utf-8")


def main() -> None:
    CMS_TEXTS.clear()
    CMS_IMAGES.clear()
    CMS_NAV.clear()
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    shutil.copytree(ROOT, OUTPUT, ignore=ignore_copy)
    normalize_local_assets()
    for page in OUTPUT.rglob("*.html"):
        transform_html(page)
        add_local_runtime(page)
    disable_data_loaders()
    write_cms_slots()
    for stylesheet in OUTPUT.rglob("*.css"):
        content = stylesheet.read_text(encoding="utf-8", errors="replace")
        content = re.sub(r"url\(\s*(['\"]?)(?:https?:)?//[^)]+\)", "none", content, flags=re.I)
        stylesheet.write_text(content, encoding="utf-8")
    rebrand_output()


if __name__ == "__main__":
    main()