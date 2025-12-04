# Restore container-based setups

- The previous version of the app provided a way to run the application in a containerized environment using Docker or Podman, as well as run API and E2E tests against a containerized backend
- This functionality has not been tested with the new FastAPI-based backend, but it should be possible to restore it with some adjustments
- Read the previous documentation on how to set up and run the application in a containerized environment, test it, and apply the necessary changes to make it compatible with the new backend.

- Key areas to focus on:
  - Update Dockerfiles and container configurations to work with FastAPI
  - Ensure that the API endpoints used in tests are compatible with the new backend
  - Verify that any environment variables or configurations required by FastAPI are correctly set in the container environment
  - Test the entire setup thoroughly to ensure that everything works as expected

  