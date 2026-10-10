async function initOperationsSchema(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS job_events (
      id BIGSERIAL PRIMARY KEY, service TEXT NOT NULL, job_id INT NOT NULL,
      actor_id INT REFERENCES users(id) ON DELETE SET NULL, actor_role TEXT,
      event TEXT NOT NULL, old_status TEXT, new_status TEXT,
      old_driver_id INT, new_driver_id INT, reason TEXT,
      details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(service,job_id,created_at);
    CREATE TABLE IF NOT EXISTS delivery_ledger (
      id BIGSERIAL PRIMARY KEY, service TEXT NOT NULL, job_id INT NOT NULL,
      driver_id INT NOT NULL REFERENCES users(id), order_value NUMERIC(12,2) NOT NULL,
      delivery_fee NUMERIC(12,2) NOT NULL, commission NUMERIC(12,2) NOT NULL,
      driver_net NUMERIC(12,2) NOT NULL, merchant_due NUMERIC(12,2) NOT NULL DEFAULT 0,
      purchase_cost NUMERIC(12,2), merchant_paid NUMERIC(12,2), cash_collected NUMERIC(12,2),
      delivered_at TIMESTAMPTZ NOT NULL, UNIQUE(service,job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_ledger_driver ON delivery_ledger(driver_id,delivered_at);
    CREATE TABLE IF NOT EXISTS driver_settlements (
      id BIGSERIAL PRIMARY KEY, driver_id INT NOT NULL REFERENCES users(id),
      actor_id INT NOT NULL REFERENCES users(id), direction TEXT NOT NULL CHECK(direction IN ('driver_to_platform','platform_to_driver')),
      amount NUMERIC(12,2) NOT NULL CHECK(amount>0), reason TEXT NOT NULL,
      request_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(driver_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS support_requests (
      id BIGSERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), service TEXT NOT NULL,
      job_id INT NOT NULL, category TEXT NOT NULL, message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', resolved_by INT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_support_open ON support_requests(user_id,service,job_id) WHERE status='open';
    CREATE TABLE IF NOT EXISTS diagnostic_events (
      id BIGSERIAL PRIMARY KEY, request_id TEXT, source TEXT NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL, route TEXT, code TEXT NOT NULL,
      resolved_by INT REFERENCES users(id), resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_diagnostic_recent ON diagnostic_events(created_at);
    INSERT INTO app_settings(key,value) VALUES('commission_percent','0'),('late_minutes','30'),('support_phone','') ON CONFLICT DO NOTHING;
  `);
  for (const table of ['orders','trips','hataali_orders']) {
    // Existing jobs stay at their original zero commission. Only new jobs use the setting.
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cash_collected NUMERIC(12,2)`);
  }
  await query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_paid NUMERIC(12,2)');
  await query('ALTER TABLE delivery_ledger ADD COLUMN IF NOT EXISTS merchant_paid NUMERIC(12,2)');
  await query('ALTER TABLE hataali_orders ADD COLUMN IF NOT EXISTS purchase_cost NUMERIC(12,2)');
  await query(`
    CREATE OR REPLACE FUNCTION wasal_snapshot_commission() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      SELECT COALESCE(value::numeric,0) INTO NEW.commission_percent FROM app_settings WHERE key='commission_percent';
      NEW.commission_percent := COALESCE(NEW.commission_percent,0);
      RETURN NEW;
    END $$;
    CREATE OR REPLACE FUNCTION wasal_job_event() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE aid INT; role_name TEXT; fee NUMERIC; job_value NUMERIC; merchant NUMERIC := 0;
      cost NUMERIC; paid NUMERIC; finished TIMESTAMPTZ; commission_amount NUMERIC;
    BEGIN
      aid := NULLIF(current_setting('wasal.actor_id',true),'')::INT;
      IF aid IS NULL AND TG_OP='INSERT' THEN aid := NEW.customer_id; END IF;
      SELECT role INTO role_name FROM users WHERE id=aid;
      IF TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR OLD.driver_id IS DISTINCT FROM NEW.driver_id THEN
        INSERT INTO job_events(service,job_id,actor_id,actor_role,event,old_status,new_status,old_driver_id,new_driver_id,reason)
        VALUES(TG_ARGV[0],NEW.id,aid,COALESCE(role_name,'system'),
          CASE WHEN TG_OP='INSERT' THEN 'created' WHEN OLD.status IS DISTINCT FROM NEW.status THEN 'status' ELSE 'assignment' END,
          CASE WHEN TG_OP='UPDATE' THEN OLD.status END,NEW.status,
          CASE WHEN TG_OP='UPDATE' THEN OLD.driver_id END,NEW.driver_id,NULLIF(current_setting('wasal.reason',true),''));
      END IF;
      IF NEW.status='delivered' AND NEW.driver_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'delivered') THEN
        PERFORM pg_advisory_xact_lock(78452,NEW.driver_id);
        IF TG_ARGV[0]='store' THEN
          fee := NEW.delivery_fee; job_value := NEW.total; merchant := COALESCE(NEW.subtotal,0); paid := NEW.merchant_paid; finished := COALESCE(NEW.delivered_at,NOW());
        ELSIF TG_ARGV[0]='trip' THEN fee := NEW.price; job_value := NEW.price; finished := NEW.updated_at;
        ELSE fee := NEW.delivery_fee; cost := NEW.purchase_cost; job_value := fee+COALESCE(cost,0); finished := NEW.updated_at;
        END IF;
        commission_amount := round(fee*NEW.commission_percent/100,2);
        INSERT INTO delivery_ledger(service,job_id,driver_id,order_value,delivery_fee,commission,driver_net,merchant_due,purchase_cost,cash_collected,merchant_paid,delivered_at)
        VALUES(TG_ARGV[0],NEW.id,NEW.driver_id,COALESCE(job_value,fee),fee,commission_amount,fee-commission_amount,merchant-COALESCE(paid,0),cost,NEW.cash_collected,paid,finished)
        ON CONFLICT(service,job_id) DO NOTHING;
      END IF;
      RETURN NEW;
    END $$;
    CREATE OR REPLACE FUNCTION wasal_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status IN ('delivered','cancelled','rejected') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.driver_id IS DISTINCT FROM OLD.driver_id) THEN
        RAISE EXCEPTION 'Terminal jobs cannot be reopened or reassigned' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
  `);
  for (const [table, service] of [['orders','store'],['trips','trip'],['hataali_orders','hataali']]) {
    await query(`DROP TRIGGER IF EXISTS wasal_commission ON ${table}; CREATE TRIGGER wasal_commission BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION wasal_snapshot_commission()`);
    await query(`DROP TRIGGER IF EXISTS wasal_events ON ${table}; CREATE TRIGGER wasal_events AFTER INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION wasal_job_event('${service}')`);
    await query(`DROP TRIGGER IF EXISTS wasal_terminal ON ${table}; CREATE TRIGGER wasal_terminal BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION wasal_terminal_guard()`);
    // Backfill delivered jobs once; leave unrecorded cash explicitly unconfirmed.
    const fee = service==='trip'?'price':'delivery_fee';
    const value = service==='store'?'COALESCE(total,delivery_fee)':service==='trip'?'price':'delivery_fee+COALESCE(purchase_cost,0)';
    const time = service==='store'?'COALESCE(delivered_at,created_at)':'updated_at';
    await query(`INSERT INTO delivery_ledger(service,job_id,driver_id,order_value,delivery_fee,commission,driver_net,merchant_due,purchase_cost,cash_collected,merchant_paid,delivered_at)
      SELECT '${service}',id,driver_id,${value},${fee},round(${fee}*commission_percent/100,2),${fee}-round(${fee}*commission_percent/100,2),
      ${service==='store'?'COALESCE(subtotal,0)-COALESCE(merchant_paid,0)':'0'},${service==='hataali'?'purchase_cost':'NULL'},cash_collected,${service==='store'?'merchant_paid':'NULL'},${time}
      FROM ${table} WHERE status='delivered' AND driver_id IS NOT NULL ON CONFLICT(service,job_id) DO NOTHING`);
  }
}
module.exports = { initOperationsSchema };
