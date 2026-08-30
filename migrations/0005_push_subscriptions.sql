-- Web-Push-Subscriptions: ein Endpoint pro Gerät, mehrere pro Nutzer erlaubt

CREATE TABLE push_subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_push_user ON push_subscriptions(user_id);
