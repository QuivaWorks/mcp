Task Actions

evari-olympus/workspaces-service/handler/task_actions.go

{
"is_public": false,
"method": "GET",
"path": "/workspaces/task/{task_id}/action",
"resource": "microstrate.workspaces.put.task-action",
"resource_type": "service"
},
{
"is_public": false,
"method": "PUT",
"path": "/workspaces/task/{task_id}/action",
"resource": "microstrate.workspaces.put.task-action",
"resource_type": "service"
},
{
"is_public": false,
"method": "DELETE",
"path": "/workspaces/task/{task_id}/action/{id}",
"resource": "microstrate.workspaces.delete.task-action",
"resource_type": "service"
}

Approvals

{
"is_public": false,
"method": "GET",
"path": "/workspaces/approvals",
"resource": "microstrate.workspaces.get.approvals",
"resource_type": "service"
},
{
"is_public": false,
"method": "POST",
"path": "/workspaces/approvals",
"resource": "microstrate.workspaces.post.approval",
"resource_type": "service"
},
{
"is_public": false,
"method": "DELETE",
"path": "/workspaces/approvals/{id}",
"resource": "microstrate.workspaces.delete.approval",
"resource_type": "service"
},
{
"is_public": false,
"method": "GET",
"path": "/workspaces/approvals/{id}",
"resource": "microstrate.workspaces.get.approval",
"resource_type": "service"
},
{
"is_public": true,
"method": "PATCH",
"path": "/workspaces/approvals/{id}/approve",
"resource": "microstrate.workspaces.patch.approval-approve",
"resource_type": "service"
},
{
"is_public": true,
"method": "POST",
"path": "/workspaces/approvals/{id}/events",
"resource": "microstrate.workspaces.post.approval-event",
"resource_type": "service"
},
{
"is_public": false,
"method": "GET",
"path": "/workspaces/approvals/{id}/events",
"resource": "microstrate.workspaces.get.approval-events",
"resource_type": "service"
},
{
"is_public": true,
"method": "PATCH",
"path": "/workspaces/approvals/{id}/reject",
"resource": "microstrate.workspaces.patch.approval-reject",
"resource_type": "service"
}

Client Folder Create
{
"is_public": false,
"method": "POST",
"path": "/workspaces/client",
"resource": "microstrate.workspaces.post.client-folder",
"resource_type": "service"
}

Files & Folders

{
"is_public": false,
"method": "PATCH",
"path": "/workspaces/file/{name}/metadata",
"resource": "microstrate.workspaces.patch.file-metadata",
"resource_type": "service"
},
{
"is_public": false,
"method": "DELETE",
"path": "/workspaces/files",
"resource": "microstrate.workspaces.delete.file",
"resource_type": "service"
},
{
"is_public": false,
"method": "GET",
"path": "/workspaces/files",
"resource": "microstrate.workspaces.get.files",
"resource_type": "service"
},
{
"is_public": false,
"method": "DELETE",
"path": "/workspaces/files/folder",
"resource": "microstrate.workspaces.delete.folder",
"resource_type": "service"
},
{
"is_public": false,
"method": "POST",
"path": "/workspaces/files/folder",
"resource": "microstrate.workspaces.post.folder",
"resource_type": "service"
},
{
"is_public": false,
"method": "POST",
"path": "/workspaces/files/restore",
"resource": "microstrate.workspaces.post.restore-trash",
"resource_type": "service"
},
{
"is_public": false,
"method": "GET",
"path": "/workspaces/files/trash",
"resource": "microstrate.workspaces.get.trash-files",
"resource_type": "service"
}

Workspace Tasks

"time_tracking": TimeTracking
export type TimeSpent = {
time_in_seconds: number
}

// User snapshot stored on a time log — deliberately excludes avatar info.
export type TimeLogUser = {
id: string
name: string
}

export type TimeLog = {
id: string
time_spent: TimeSpent
started_at: string // ISO 8601 — when the tracked work started
description?: string
user: TimeLogUser
created_at: string // ISO 8601
updated_at?: string
}

// All time-tracking data for a task lives in this single object: the original
// effort estimate plus every logged time entry. Totals/remaining/progress are
// derived on the frontend from these values.
export type TimeTracking = {
estimate?: TimeSpent
logs: TimeLog[]
}

Records

validate: true/false
should the data be validated against the config schema?

New propeties that allow us to trigger flows with record data:

completed: true/false
Optional, passed on create/update.
If true, the record event might trigger flows if there are flows that are configured to run on the given record config

"test_flow": {
"subject": "ms.hub.config.workflow.draft.1389718614.1365955493", //flow subject
"run_id": "{uid}" //allows us to track the execution
}
Can be passed on record create - runs the specified flow and does not activate any other triggers
