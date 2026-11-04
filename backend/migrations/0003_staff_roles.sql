CREATE TABLE IF NOT EXISTS staff_roles (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role = 'manager'),
    created_at INTEGER NOT NULL
);