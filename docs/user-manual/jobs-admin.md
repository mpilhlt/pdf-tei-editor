# Jobs

Long-running operations such as text recognition, extraction and backups run as jobs on the server. Administrators see the jobs of all users in **Tools** > **Administration** > **Jobs**. The entry is only shown to users with the admin role.

The dialog lists one job per row with its type, owner, status, progress, creation time and time of the last update, newest first. It refreshes every five seconds while it is open.

| Control | Effect |
| --- | --- |
| **Status** | **Unfinished** shows queued, active and interrupted jobs; **All** also shows finished, failed and cancelled jobs |
| **Type** | Restricts the list to one job type |
| **Cancel** (unfinished jobs) | Asks the job to stop; an active job turns to `cancelled` as soon as it has stopped |
| **Delete** (finished jobs) | Removes the job and its output files |
| **Cancel all unfinished** | After a confirmation, cancels all unfinished jobs of all users, or only those of the chosen type |

Users see and cancel only their own jobs, in the progress widgets of the editor.
