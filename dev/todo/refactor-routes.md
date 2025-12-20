# Refactor route paths.

At the moment, we have three different path with routes:

- `fastapi_app/api`
- `fastapi_app/routers`
- `fastapi_app/routes`

This is confusing. Consolidate and put all the route files into a path following best practices for FastAPI applications.
