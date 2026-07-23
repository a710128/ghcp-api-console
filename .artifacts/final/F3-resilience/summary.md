=== F3: Compose Resilience Drill ===
### PostgreSQL Schema Verification
 schemaname |      tablename       
------------+----------------------
 login      | job_outbox
 login      | result_outbox
 login      | task_secrets
 login      | tasks
 proxy      | accounts
 sso        | budget_cache
 sso        | emu_import_plan_rows
 sso        | emu_import_plans
 sso        | scim_rate_limits
 sso        | users
(10 rows)


### Foreign Key Cascade Verification
INSERT 0 1
INSERT 0 1
INSERT 0 1
 phase  | tasks 
--------+-------
 Before |     1
 Before |     1
 Before |     1
(3 rows)

DELETE 1
 phase | tasks 
-------+-------
 After |     0
 After |     0
 After |     0
(3 rows)


### Duplicate Task Detection
INSERT 0 1
 existing_active 
-----------------
               1
(1 row)

DELETE 1

### SCIM Rate Limit Coordination
    id     |        next_allowed_at        
-----------+-------------------------------
 singleton | 2026-07-22 18:58:36.318225+00
(1 row)


### Compose Config Assertions
Backup/restore services: NONE
PostgreSQL published ports: NONE - postgres has no published ports

### F3 VERDICT: APPROVE
