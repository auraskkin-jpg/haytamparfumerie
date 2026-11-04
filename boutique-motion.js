(() => {
  "use strict";

  const slider = document.querySelector(".hp-bslider");
  if (!slider) return;

  const radios = [...slider.querySelectorAll('input[name="hp-bslider-radio"]')];
  const controls = [...slider.querySelectorAll(".hp-bslider__manual-btn")];
  if (!radios.length) return;

  const duration = 6500;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const progressTrack = document.createElement("div");
  const progressFill = document.createElement("div");
  progressTrack.className = "hp-bslider__progress-track";
  progressTrack.setAttribute("aria-hidden", "true");
  progressFill.className = "hp-bslider__progress-fill";
  progressTrack.append(progressFill);
  slider.append(progressTrack);

  let activeIndex = Math.max(0, radios.findIndex((radio) => radio.checked));
  let remaining = duration;
  let startedAt = 0;
  let animationFrame = 0;
  let isHovered = false;
  let hasFocus = false;
  let isVisible = !document.hidden;
  let isInViewport = true;
  let touchStartX = null;

  function updateControls() {
    controls.forEach((control, index) => {
      control.setAttribute("aria-label", `Afficher la bannière ${index + 1} sur ${controls.length}`);
      control.setAttribute("aria-controls", radios[index]?.id || "");
      control.setAttribute("aria-current", index === activeIndex ? "true" : "false");
      control.tabIndex = index === activeIndex ? 0 : -1;
    });
  }

  function pause() {
    if (!animationFrame) return;
    window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    remaining = Math.max(0, duration - (performance.now() - startedAt));
  }

  function tick(now) {
    const elapsed = now - startedAt;
    const progress = Math.min(1, elapsed / duration);
    progressFill.style.transform = `scaleX(${progress})`;
    if (progress >= 1) {
      setActive((activeIndex + 1) % radios.length);
      return;
    }
    animationFrame = window.requestAnimationFrame(tick);
  }

  function play() {
    if (reducedMotion.matches || isHovered || hasFocus || !isVisible || !isInViewport || animationFrame) return;
    startedAt = performance.now() - (duration - remaining);
    animationFrame = window.requestAnimationFrame(tick);
  }

  function setActive(index) {
    pause();
    activeIndex = (index + radios.length) % radios.length;
    radios[activeIndex].checked = true;
    remaining = duration;
    progressFill.style.transform = "scaleX(0)";
    updateControls();
    play();
  }

  radios.forEach((radio, index) => {
    radio.addEventListener("change", () => {
      if (radio.checked) setActive(index);
    });
  });

  controls.forEach((control, index) => {
    control.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === "Home" ? 0
        : event.key === "End" ? radios.length - 1
          : activeIndex + (event.key === "ArrowRight" ? 1 : -1);
      setActive(target);
      controls[activeIndex]?.focus();
    });
  });

  slider.addEventListener("pointerenter", () => {
    isHovered = true;
    pause();
  });
  slider.addEventListener("pointerleave", () => {
    isHovered = false;
    play();
  });
  slider.addEventListener("focusin", () => {
    hasFocus = true;
    pause();
  });
  slider.addEventListener("focusout", (event) => {
    hasFocus = slider.contains(event.relatedTarget);
    play();
  });
  slider.addEventListener("pointerdown", (event) => {
    touchStartX = event.pointerType === "touch" ? event.clientX : null;
  }, { passive: true });
  slider.addEventListener("pointerup", (event) => {
    if (touchStartX === null) return;
    const distance = event.clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(distance) < 48) return;
    event.preventDefault();
    setActive(activeIndex + (distance < 0 ? 1 : -1));
  });
  document.addEventListener("visibilitychange", () => {
    isVisible = !document.hidden;
    isVisible ? play() : pause();
  });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) pause();
    else play();
  });

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(([entry]) => {
      isInViewport = entry.isIntersecting;
      isInViewport ? play() : pause();
    }, { threshold: 0.1 });
    observer.observe(slider);
  }

  if (!radios.some((radio) => radio.checked)) radios[0].checked = true;
  updateControls();
  play();
})();