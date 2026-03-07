-- Notify copy-trader instantly when a new trade is detected
CREATE OR REPLACE FUNCTION notify_detected_trade()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('detected_trade_inserted',
    json_build_object(
      'side', NEW.side,
      'proxyWallet', NEW."proxyWallet",
      'detectionSource', NEW."detectionSource"
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER detected_trade_notify_trigger
  AFTER INSERT ON "DetectedTrade"
  FOR EACH ROW EXECUTE FUNCTION notify_detected_trade();
