-- =============================================================================
-- 007_business_open_days.sql
--
-- Opening hours (001) said when a business opens each day but not which days
-- it opens at all, so a request for a Sunday at 10:00 was judged only on the
-- time. open_days lists the ISO weekdays (1 = Monday ... 7 = Sunday) the
-- business takes bookings, read as calendar days in the business's own
-- timezone: the weekday of a local date does not depend on DST or on where the
-- client is.
--
-- The default is every day, which is what every existing tenant has been
-- promising until now (the seeded demo tenants included), so applying this
-- changes no existing behaviour. A business restricts it per row; there is no
-- settings screen for it in this scope.
-- =============================================================================

ALTER TABLE businesses
  ADD COLUMN open_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  ADD CONSTRAINT businesses_open_days_valid CHECK (
    cardinality(open_days) BETWEEN 1 AND 7
    AND open_days <@ '{1,2,3,4,5,6,7}'::smallint[]
  );

COMMENT ON COLUMN businesses.open_days IS
  'ISO weekdays (1 = Monday .. 7 = Sunday) the business takes bookings, in its own timezone.';
