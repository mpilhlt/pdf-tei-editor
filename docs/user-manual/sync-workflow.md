# WebDAV-based synchronization

The PDF and XML files that have been uploaded, generated, and edited with this application can be synchronized with a WebDAV server. This is useful as a backup (especially if the WebDAV server provides versioning) and if several instances of the application share a common repository. 

The WebDAV server is configured via environment variables in the `.env` file (see `.env.development` or `.env.production` for available options).

It automatically starts a synchronization after changes in the filesystem. 