# Live database lane registrations

One `<domain>.js` per domain, loaded in file-name order by `nodes/scripts/tasks.js`
(the shape, the run order and what registering changes are documented in the
registry notes at the top of that file; `docs/development/nodes/testing.md` has the
user-facing description). The folder holds no registration in the shared base: a
domain adds its own file together with its servers script in `nodes/test/db-services/`.
