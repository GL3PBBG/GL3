-- Core relinquishes the last-but-one table it never touched.
--
-- `properties` shipped in 0000_core_schema because the core schema predated
-- the plugin migration runner. Its single consumer is the `properties` plugin,
-- which now owns and creates it as p_properties_properties. 0007 and 0009 are
-- the precedent; DROP not RENAME for the reason 0007 gives.
DROP TABLE IF EXISTS "properties" CASCADE;
