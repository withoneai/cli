# Create an Issue for a Repository

## Prerequisites

- The authenticated user must have **pull access** to the target repository.
- Issues must be enabled for the repository (otherwise the API returns **410 Gone**).

## Method

`POST`

## URL

`https://api.github.com/repos/{{owner}}/{{repo}}/issues`

## Headers

```json
{
  "Accept": "application/json",
  "Content-Type": "application/json"
}
```

## Description

Creates a new issue in the specified repository. This endpoint triggers notifications. Creating issues too quickly may result in **secondary rate limiting**.

This endpoint supports custom media types that affect how the issue body is returned (raw markdown, text, HTML, or all).

## Enforcement Rules

- The `owner` path parameter **must always be present** and **non-empty**.
- The `repo` path parameter **must always be present** and **non-empty**.
- Always construct the path as `/repos/{{owner}}/{{repo}}/issues`.
- Do **not** call the API with missing or empty path parameters (e.g., `/repos//my-repo/issues`, `/repos/octocat//issues`).
- Do **not** infer or guess `owner` or `repo` values.
- When executing the action, ensure to send **Path Parameters** in the URL and **not** in the body.
- When executing the action, ensure to send **Query Parameters** in the URL as query parameters and **not** in the body. (This endpoint does not document any query parameters.)

### Valid Examples

```http
/repos/octocat/hello-world/issues
/repos/my-org/platform-api/issues
```

### Invalid Examples

```http
/repos//hello-world/issues
/repos/octocat//issues
/repos/octocat/hello-world
```

## Required Path Parameters

| Parameter | Type   | Description |
|----------|--------|-------------|
| `owner`  | string | The account owner of the repository. Not case sensitive. |
| `repo`   | string | The name of the repository without the `.git` extension. Not case sensitive. |

## Required Request Body Fields

| Parameter | Type | Description |
|----------|------|-------------|
| `title`  | string \| integer | Title of the issue. |

## Optional Request Body Fields

| Parameter | Type | Description |
|----------|------|-------------|
| `body` | string | The contents of the issue. |
| `assignee` | string | Login for the user that this issue should be assigned to. **Note:** only users with push access can set the assignee; otherwise it is silently dropped. **This field is closing down.** |
| `milestone` | string \| integer | Milestone to associate with this issue. |
| `labels` | array | Labels to associate with this issue. Items are `string` or an object: `{ id: integer, name: string, description: string, color: string }`. **Note:** only users with push access can set labels; otherwise they are silently dropped. |
| `assignees` | string[] | Logins for users to assign to this issue. **Note:** only users with push access can set assignees; otherwise they are silently dropped. |
| `type` | string | The name of the issue type to associate with this issue (example: `"Epic"`). **Note:** only users with push access can set the type; otherwise it is silently dropped. |

## Response

### Success Response (201 Created)

Response includes a `Location` header.

```json
{
  "id": 1,
  "node_id": "MDU6SXNzdWUx",
  "url": "https://api.github.com/repositories/42/issues/1",
  "repository_url": "https://api.github.com/repositories/42",
  "labels_url": "https://api.github.com/repositories/42/issues/1/labels{/name}",
  "comments_url": "https://api.github.com/repositories/42/issues/1/comments",
  "events_url": "https://api.github.com/repositories/42/issues/1/events",
  "html_url": "https://github.com/octocat/Hello-World/issues/1",
  "number": 42,
  "state": "open",
  "state_reason": "not_planned",
  "title": "Widget creation fails in Safari on OS X 10.8",
  "body": "It looks like the new widget form is broken on Safari. When I try and create the widget, Safari crashes. This is reproducible on 10.8, but not 10.9. Maybe a browser bug?",
  "user": {
    "name": "The Octocat",
    "email": "octocat@github.com",
    "login": "octocat",
    "id": 1,
    "node_id": "MDQ6VXNlcjE=",
    "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4",
    "gravatar_id": "",
    "url": "https://api.github.com/users/octocat",
    "html_url": "https://github.com/octocat",
    "followers_url": "https://api.github.com/users/octocat/followers",
    "following_url": "https://api.github.com/users/octocat/following{/other_user}",
    "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",
    "organizations_url": "https://api.github.com/users/octocat/orgs",
    "repos_url": "https://api.github.com/users/octocat/repos",
    "events_url": "https://api.github.com/users/octocat/events{/privacy}",
    "received_events_url": "https://api.github.com/users/octocat/received_events",
    "type": "User",
    "site_admin": false,
    "starred_at": "2020-07-09T00:17:55Z",
    "user_view_type": "public"
  },
  "labels": [
    "bug"
  ],
  "assignee": {
    "name": "The Octocat",
    "email": "octocat@github.com",
    "login": "octocat",
    "id": 1,
    "node_id": "MDQ6VXNlcjE=",
    "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4",
    "gravatar_id": "",
    "url": "https://api.github.com/users/octocat",
    "html_url": "https://github.com/octocat",
    "followers_url": "https://api.github.com/users/octocat/followers",
    "following_url": "https://api.github.com/users/octocat/following{/other_user}",
    "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",
    "organizations_url": "https://api.github.com/users/octocat/orgs",
    "repos_url": "https://api.github.com/users/octocat/repos",
    "events_url": "https://api.github.com/users/octocat/events{/privacy}",
    "received_events_url": "https://api.github.com/users/octocat/received_events",
    "type": "User",
    "site_admin": false,
    "starred_at": "2020-07-09T00:17:55Z",
    "user_view_type": "public"
  },
  "assignees": [
    {
      "name": "The Octocat",
      "email": "octocat@github.com",
      "login": "octocat",
      "id": 1,
      "node_id": "MDQ6VXNlcjE=",
      "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4",
      "gravatar_id": "",
      "url": "https://api.github.com/users/octocat",
      "html_url": "https://github.com/octocat",
      "followers_url": "https://api.github.com/users/octocat/followers",
      "following_url": "https://api.github.com/users/octocat/following{/other_user}",
      "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",
      "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",
      "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",
      "organizations_url": "https://api.github.com/users/octocat/orgs",
      "repos_url": "https://api.github.com/users/octocat/repos",
      "events_url": "https://api.github.com/users/octocat/events{/privacy}",
      "received_events_url": "https://api.github.com/users/octocat/received_events",
      "type": "User",
      "site_admin": false,
      "starred_at": "2020-07-09T00:17:55Z",
      "user_view_type": "public"
    }
  ],
  "milestone": {
    "url": "https://api.github.com/repos/octocat/Hello-World/milestones/1",
    "html_url": "https://github.com/octocat/Hello-World/milestone/1",
    "labels_url": "https://api.github.com/repos/octocat/Hello-World/milestones/1/labels",
    "id": 1,
    "node_id": "MDk6TWlsZXN0b25lMQ==",
    "number": 1,
    "state": "open",
    "title": "v1.0",
    "description": "Tracking milestone",
    "creator": null,
    "open_issues": 10,
    "closed_issues": 2,
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-02T00:00:00Z",
    "closed_at": "2024-01-10T00:00:00Z",
    "due_on": "2024-02-01T00:00:00Z"
  },
  "locked": false,
  "active_lock_reason": "too heated",
  "comments": 0,
  "pull_request": {
    "merged_at": "2024-01-05T00:00:00Z",
    "diff_url": "https://github.com/octocat/Hello-World/pull/1.diff",
    "html_url": "https://github.com/octocat/Hello-World/pull/1",
    "patch_url": "https://github.com/octocat/Hello-World/pull/1.patch",
    "url": "https://api.github.com/repos/octocat/Hello-World/pulls/1"
  },
  "closed_at": "2024-01-10T00:00:00Z",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-02T00:00:00Z",
  "draft": false,
  "closed_by": {
    "name": "The Octocat",
    "email": "octocat@github.com",
    "login": "octocat",
    "id": 1,
    "node_id": "MDQ6VXNlcjE=",
    "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4",
    "gravatar_id": "",
    "url": "https://api.github.com/users/octocat",
    "html_url": "https://github.com/octocat",
    "followers_url": "https://api.github.com/users/octocat/followers",
    "following_url": "https://api.github.com/users/octocat/following{/other_user}",
    "gists_url": "https://api.github.com/users/octocat/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/octocat/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/octocat/subscriptions",
    "organizations_url": "https://api.github.com/users/octocat/orgs",
    "repos_url": "https://api.github.com/users/octocat/repos",
    "events_url": "https://api.github.com/users/octocat/events{/privacy}",
    "received_events_url": "https://api.github.com/users/octocat/received_events",
    "type": "User",
    "site_admin": false,
    "starred_at": "2020-07-09T00:17:55Z",
    "user_view_type": "public"
  },
  "body_html": "<p>Rendered HTML</p>",
  "body_text": "Rendered text",
  "timeline_url": "https://api.github.com/repos/octocat/Hello-World/issues/1/timeline",
  "type": {
    "id": 101,
    "node_id": "IT_kwDOBQ",
    "name": "Epic",
    "description": "Large body of work",
    "color": "blue",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-02T00:00:00Z",
    "is_enabled": true
  },
  "repository": {
    "id": 42,
    "node_id": "MDEwOlJlcG9zaXRvcnk0Mg==",
    "name": "Hello-World",
    "full_name": "octocat/Hello-World",
    "license": null,
    "forks": 9,
    "permissions": {
      "admin": false,
      "pull": true,
      "triage": true,
      "push": false,
      "maintain": false
    },
    "owner": null,
    "private": false,
    "html_url": "https://github.com/octocat/Hello-World",
    "description": "My first repository on GitHub!",
    "fork": false,
    "url": "https://api.github.com/repos/octocat/Hello-World",
    "archive_url": "https://api.github.com/repos/octocat/Hello-World/{archive_format}{/ref}",
    "assignees_url": "https://api.github.com/repos/octocat/Hello-World/assignees{/user}",
    "blobs_url": "https://api.github.com/repos/octocat/Hello-World/git/blobs{/sha}",
    "branches_url": "https://api.github.com/repos/octocat/Hello-World/branches{/branch}",
    "collaborators_url": "https://api.github.com/repos/octocat/Hello-World/collaborators{/collaborator}",
    "comments_url": "https://api.github.com/repos/octocat/Hello-World/comments{/number}",
    "commits_url": "https://api.github.com/repos/octocat/Hello-World/commits{/sha}",
    "compare_url": "https://api.github.com/repos/octocat/Hello-World/compare/{base}...{head}",
    "contents_url": "https://api.github.com/repos/octocat/Hello-World/contents/{+path}",
    "contributors_url": "https://api.github.com/repos/octocat/Hello-World/contributors",
    "deployments_url": "https://api.github.com/repos/octocat/Hello-World/deployments",
    "downloads_url": "https://api.github.com/repos/octocat/Hello-World/downloads",
    "events_url": "https://api.github.com/repos/octocat/Hello-World/events",
    "forks_url": "https://api.github.com/repos/octocat/Hello-World/forks",
    "git_commits_url": "https://api.github.com/repos/octocat/Hello-World/git/commits{/sha}",
    "git_refs_url": "https://api.github.com/repos/octocat/Hello-World/git/refs{/sha}",
    "git_tags_url": "https://api.github.com/repos/octocat/Hello-World/git/tags{/sha}",
    "git_url": "git://github.com/octocat/Hello-World.git",
    "issue_comment_url": "https://api.github.com/repos/octocat/Hello-World/issues/comments{/number}",
    "issue_events_url": "https://api.github.com/repos/octocat/Hello-World/issues/events{/number}",
    "issues_url": "https://api.github.com/repos/octocat/Hello-World/issues{/number}",
    "keys_url": "https://api.github.com/repos/octocat/Hello-World/keys{/key_id}",
    "labels_url": "https://api.github.com/repos/octocat/Hello-World/labels{/name}",
    "languages_url": "https://api.github.com/repos/octocat/Hello-World/languages",
    "merges_url": "https://api.github.com/repos/octocat/Hello-World/merges",
    "milestones_url": "https://api.github.com/repos/octocat/Hello-World/milestones{/number}",
    "notifications_url": "https://api.github.com/repos/octocat/Hello-World/notifications{?since,all,participating}",
    "pulls_url": "https://api.github.com/repos/octocat/Hello-World/pulls{/number}",
    "releases_url": "https://api.github.com/repos/octocat/Hello-World/releases{/id}",
    "ssh_url": "git@github.com:octocat/Hello-World.git",
    "stargazers_url": "https://api.github.com/repos/octocat/Hello-World/stargazers",
    "statuses_url": "https://api.github.com/repos/octocat/Hello-World/statuses/{sha}",
    "subscribers_url": "https://api.github.com/repos/octocat/Hello-World/subscribers",
    "subscription_url": "https://api.github.com/repos/octocat/Hello-World/subscription",
    "tags_url": "https://api.github.com/repos/octocat/Hello-World/tags",
    "teams_url": "https://api.github.com/repos/octocat/Hello-World/teams",
    "trees_url": "https://api.github.com/repos/octocat/Hello-World/git/trees{/sha}",
    "clone_url": "https://github.com/octocat/Hello-World.git",
    "mirror_url": "git://github.com/octocat/Hello-World",
    "hooks_url": "https://api.github.com/repos/octocat/Hello-World/hooks",
    "svn_url": "https://svn.github.com/octocat/Hello-World",
    "homepage": "https://github.com",
    "language": "Ruby",
    "forks_count": 9,
    "stargazers_count": 80,
    "watchers_count": 80,
    "size": 108,
    "default_branch": "main",
    "open_issues_count": 0,
    "is_template": false,
    "topics": ["octocat", "atom", "electron", "api"],
    "has_issues": true,
    "has_projects": true,
    "has_wiki": true,
    "has_pages": false,
    "has_downloads": true,
    "has_discussions": false,
    "has_pull_requests": true,
    "pull_request_creation_policy": "all",
    "has_commit_comments": true,
    "archived": false,
    "disabled": false,
    "visibility": "public",
    "pushed_at": "2024-01-01T00:00:00Z",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-02T00:00:00Z",
    "allow_rebase_merge": true,
    "temp_clone_token": "token",
    "allow_squash_merge": true,
    "allow_auto_merge": false,
    "delete_branch_on_merge": false,
    "allow_update_branch": false,
    "use_squash_pr_title_as_default": false,
    "squash_merge_commit_title": "PR_TITLE",
    "squash_merge_commit_message": "PR_BODY",
    "merge_commit_title": "PR_TITLE",
    "merge_commit_message": "PR_BODY",
    "allow_merge_commit": true,
    "allow_forking": true,
    "web_commit_signoff_required": false,
    "open_issues": 0,
    "watchers": 80,
    "master_branch": "main",
    "starred_at": "2020-07-09T00:17:55Z",
    "anonymous_access_enabled": false,
    "code_search_index_status": {
      "lexical_search_ok": true,
      "lexical_commit_sha": "abc123"
    }
  },
  "performed_via_github_app": {
    "id": 10,
    "slug": "my-github-app",
    "node_id": "MDM6QXBwMTA=",
    "client_id": "Iv1.0123456789abcdef",
    "owner": null,
    "name": "My GitHub App",
    "description": "App description",
    "external_url": "https://example.com",
    "html_url": "https://github.com/apps/my-github-app",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-02T00:00:00Z",
    "permissions": {
      "issues": "write",
      "checks": "read",
      "metadata": "read",
      "contents": "read",
      "deployments": "read"
    },
    "events": ["issues"],
    "installations_count": 1
  },
  "author_association": "COLLABORATOR",
  "reactions": {
    "url": "https://api.github.com/repos/octocat/Hello-World/issues/1/reactions",
    "total_count": 0,
    "+1": 0,
    "-1": 0,
    "laugh": 0,
    "confused": 0,
    "heart": 0,
    "hooray": 0,
    "eyes": 0,
    "rocket": 0
  },
  "sub_issues_summary": {
    "total": 0,
    "completed": 0,
    "percent_completed": 0
  },
  "parent_issue_url": "https://api.github.com/repos/octocat/Hello-World/issues/2",
  "pinned_comment": {
    "id": 1001,
    "node_id": "IC_kwDO",
    "url": "https://api.github.com/repos/octocat/Hello-World/issues/comments/1001",
    "body": "Pinned comment body",
    "body_text": "Pinned comment body",
    "body_html": "<p>Pinned comment body</p>",
    "html_url": "https://github.com/octocat/Hello-World/issues/1#issuecomment-1001",
    "user": null,
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-02T00:00:00Z",
    "issue_url": "https://api.github.com/repos/octocat/Hello-World/issues/1",
    "author_association": "COLLABORATOR",
    "performed_via_github_app": null,
    "reactions": {
      "url": "https://api.github.com/repos/octocat/Hello-World/issues/comments/1001/reactions",
      "total_count": 0,
      "+1": 0,
      "-1": 0,
      "laugh": 0,
      "confused": 0,
      "heart": 0,
      "hooray": 0,
      "eyes": 0,
      "rocket": 0
    },
    "pin": null
  },
  "issue_dependencies_summary": {
    "blocked_by": 0,
    "blocking": 0,
    "total_blocked_by": 0,
    "total_blocking": 0
  },
  "issue_field_values": [
    {
      "issue_field_id": 1,
      "node_id": "IFV_kwDO",
      "data_type": "text",
      "value": "Some value",
      "single_select_option": {
        "id": 10,
        "name": "Option A",
        "color": "blue"
      }
    }
  ]
}
```

### Error Response (400 Bad Request)

```json
{
  "message": "Bad Request",
  "documentation_url": "https://docs.github.com/rest",
  "url": "https://api.github.com/repos/octocat/Hello-World/issues",
  "status": "400"
}
```

### Error Response (403 Forbidden)

```json
{
  "message": "Forbidden",
  "documentation_url": "https://docs.github.com/rest",
  "url": "https://api.github.com/repos/octocat/Hello-World/issues",
  "status": "403"
}
```

### Error Response (404 Resource not found)

```json
{
  "message": "Not Found",
  "documentation_url": "https://docs.github.com/rest",
  "url": "https://api.github.com/repos/octocat/Hello-World/issues",
  "status": "404"
}
```

### Error Response (410 Gone)

```json
{
  "message": "Gone",
  "documentation_url": "https://docs.github.com/rest",
  "url": "https://api.github.com/repos/octocat/Hello-World/issues",
  "status": "410"
}
```

### Error Response (422 Validation failed, or the endpoint has been spammed)

```json
{
  "message": "Validation Failed",
  "documentation_url": "https://docs.github.com/rest",
  "errors": [
    {
      "resource": "Issue",
      "field": "title",
      "message": "title is too short",
      "code": "invalid",
      "index": 0,
      "value": "A"
    }
  ]
}
```

### Error Response (503 Service unavailable)

```json
{
  "code": "service_unavailable",
  "message": "Service unavailable",
  "documentation_url": "https://docs.github.com/rest"
}
```

## Response Fields

| Field | Type | Description |
|------|------|-------------|
| `id` | integer | Unique identifier of the issue. |
| `node_id` | string | Node ID of the issue. |
| `url` | string | API URL for the issue. |
| `repository_url` | string | API URL for the repository. |
| `labels_url` | string | API URL template for issue labels. |
| `comments_url` | string | API URL for issue comments. |
| `events_url` | string | API URL for issue events. |
| `html_url` | string | Web URL for the issue. |
| `number` | integer | Number uniquely identifying the issue within its repository. |
| `state` | string | State of the issue (`open` or `closed`). |
| `state_reason` | string | Reason for the current state. Possible values: `completed`, `reopened`, `not_planned`, `duplicate`. |
| `title` | string | Title of the issue. |
| `body` | string | Contents of the issue (raw markdown). Present depending on requested media type. |
| `body_text` | string | Text-only representation of the markdown body. Present depending on requested media type. |
| `body_html` | string | HTML rendered from the markdown body. Present depending on requested media type. |
| `user` | object | The user who created the issue. |
| `user.login` | string | Login of the user. |
| `user.id` | integer | ID of the user. |
| `labels` | array | Labels associated with the issue. |
| `assignee` | object | The assigned user. |
| `assignees` | array | Assigned users. |
| `milestone` | object | Associated milestone. |
| `milestone.number` | integer | The number of the milestone. |
| `milestone.state` | string | Milestone state (`open` or `closed`). Default: `"open"`. |
| `locked` | boolean | Whether the issue is locked. |
| `active_lock_reason` | string | Reason the issue is locked. |
| `comments` | integer | Number of comments. |
| `pull_request` | object | Pull request details if this issue is a pull request. |
| `created_at` | string | ISO 8601 timestamp when the issue was created. |
| `updated_at` | string | ISO 8601 timestamp when the issue was last updated. |
| `closed_at` | string | ISO 8601 timestamp when the issue was closed. |
| `draft` | boolean | Whether the issue is a draft. |
| `closed_by` | object | The user who closed the issue. |
| `timeline_url` | string | API URL for the issue timeline. |
| `type` | object | The issue type associated with the issue. |
| `type.id` | integer | Unique identifier of the issue type. |
| `type.name` | string | Name of the issue type. |
| `type.color` | string | Color of the issue type. Possible values: `gray`, `blue`, `green`, `yellow`, `orange`, `red`, `pink`, `purple`. |
| `type.is_enabled` | boolean | Whether the issue type is enabled. |
| `repository` | object | Repository object (included in response example). |
| `performed_via_github_app` | object | GitHub App that performed the action (if applicable). |
| `author_association` | string | Author association enum. |
| `reactions` | object | Reactions summary. |
| `sub_issues_summary` | object | Summary of sub-issues progress. |
| `parent_issue_url` | string | URL to get the parent issue (if this is a sub-issue). |
| `pinned_comment` | object | Pinned comment details (if present). |
| `issue_dependencies_summary` | object | Dependencies summary (blocked_by/blocking). |
| `issue_field_values` | array | Issue field values (custom fields). |

## Sample Request

```bash
curl -i --request POST \
  'https://api.github.com/repos/octocat/Hello-World/issues' \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/json' \
  --data '{
    "title": "Found a bug",
    "body": "I'\''m having a problem with this.",
    "assignees": ["octocat"],
    "milestone": 1,
    "labels": ["bug"]
  }'
```

## Example Usage

### Example 1: Create a minimal issue

```bash
curl -i -X POST \
  'https://api.github.com/repos/octocat/Hello-World/issues' \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Build fails on Windows"
  }'
```

### Example 2: Create an issue with labels and multiple assignees

```bash
curl -i -X POST \
  'https://api.github.com/repos/my-org/platform-api/issues' \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Investigate latency spike",
    "body": "Latency increased after deploy.",
    "labels": ["performance", "needs-triage"],
    "assignees": ["alice", "bob"]
  }'
```

### Example 3: Associate an issue type

```bash
curl -i -X POST \
  'https://api.github.com/repos/octocat/Hello-World/issues' \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Epic: Q2 migration",
    "type": "Epic"
  }'
```

## Behavior

1. Validates that issues are enabled for the repository (otherwise returns **410 Gone**).
2. Creates the issue and triggers notifications.
3. May silently drop `assignee`, `assignees`, `labels`, and `type` if the authenticated user lacks push access (as documented).
4. Returns the created issue object with status **201** and a `Location` header.

## Notes

- Custom media types supported (affects returned body fields):
  - `application/vnd.github.raw+json` (default): includes `body`
  - `application/vnd.github.text+json`: includes `body_text`
  - `application/vnd.github.html+json`: includes `body_html`
  - `application/vnd.github.full+json`: includes `body`, `body_text`, `body_html`
- Creating content too quickly may trigger secondary rate limiting.

## Gotchas

- If issues are disabled on the repository, you will receive **410 Gone**.
- If the endpoint has been spammed or validation fails, you may receive **422**.
- `assignee` is documented as “closing down” and may be deprecated; prefer `assignees` when applicable.

## Error Handling

- **400 Bad Request**: Request is malformed.
- **403 Forbidden**: Insufficient permissions.
- **404 Not Found**: Repository or resource not found.
- **410 Gone**: Issues are disabled for the repository.
- **422 Unprocessable Entity**: Validation failed or endpoint spammed (includes an `errors` array).
- **503 Service Unavailable**: Service temporarily unavailable.