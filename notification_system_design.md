# Stage 1

### Core Actions
1. **Fetch Notifications**: Get a list of notifications for the logged-in user.
2. **Mark as Read**: Mark a specific notification or all notifications as read.
3. **Receive Real-time Notification**: Receive an event when a new notification is generated.

### REST API Endpoints

#### 1. Fetch Notifications
**Endpoint**: `GET /api/v1/notifications`
**Description**: Fetches the list of notifications for the currently authenticated user.

**Headers**:
```json
{
  "Authorization": "Bearer <JWT_TOKEN>"
}
```

**Request**: No body needed, can include query params `?status=unread&limit=20`

**Response (200 OK)**:
```json
{
  "notifications": [
    {
      "id": "uuid-1234",
      "type": "Placement",
      "message": "CSX Corporation hiring",
      "status": "unread",
      "createdAt": "2026-04-22T17:51:18Z"
    }
  ],
  "meta": {
    "totalUnread": 1
  }
}
```

#### 2. Mark Notification as Read
**Endpoint**: `PATCH /api/v1/notifications/:id/read`
**Description**: Updates the status of a notification to 'read'.

**Headers**:
```json
{
  "Authorization": "Bearer <JWT_TOKEN>"
}
```

**Response (200 OK)**:
```json
{
  "success": true,
  "message": "Notification marked as read"
}
```

### Real-Time Mechanism
To push notifications in real-time to logged-in users, we will use **WebSockets** (e.g., using `Socket.io` or standard `ws`). 
- When a user logs in, they establish a persistent WebSocket connection with the notification server.
- The server maps the active WebSocket connection to the `userId`.
- When an event occurs (Placement, Result, Event), the backend service publishes a message to a message broker (e.g., Redis Pub/Sub, Kafka or RabbitMQ).
- The Notification WebSocket server subscribes to these events and instantly pushes the JSON payload down the active WebSocket connection to the targeted `userId`.
- If the user is offline, the notification remains in the DB, to be fetched via the REST API on their next login.

---

# Stage 2

### Database Choice: PostgreSQL
**Reasoning**: Notifications involve structured, relational data (Users, Notification Types, Read Statuses). PostgreSQL provides robust ACID compliance, JSONB support if we need to store flexible payload data, and excellent performance for read/write heavy workloads when properly indexed.

### DB Schema

**Table: `users`**
- `id` (UUID, Primary Key)
- `email` (VARCHAR, Unique)
- `name` (VARCHAR)

**Table: `notifications`**
- `id` (UUID, Primary Key)
- `student_id` (UUID, Foreign Key -> users.id)
- `notification_type` (ENUM: 'Event', 'Result', 'Placement')
- `message` (TEXT)
- `is_read` (BOOLEAN, Default: false)
- `created_at` (TIMESTAMP, Default: CURRENT_TIMESTAMP)

### Data Volume Problems & Solutions
**Problem**: As the volume grows (e.g., millions of records), queries filtering by `student_id` and `is_read` will become slow (Sequential Scans). The database size will explode, leading to slower backups and increased storage costs.
**Solution**: 
1. **Indexing**: Add composite indexes on `(student_id, is_read, created_at)` to speed up fetch queries.
2. **Data Archival / Partitioning**: Implement table partitioning by date (e.g., monthly partitions) so older notifications do not degrade performance. We can archive or delete notifications older than 6 months.
3. **Caching**: Use a caching layer like Redis to store the unread count or the recent top 20 notifications per active user.

### SQL Queries based on REST API

**Fetch Unread Notifications**:
```sql
SELECT id, notification_type, message, created_at 
FROM notifications
WHERE student_id = ? AND is_read = false
ORDER BY created_at DESC
LIMIT 20;
```

**Mark as Read**:
```sql
UPDATE notifications 
SET is_read = true 
WHERE id = ? AND student_id = ?;
```

---

# Stage 3

### Query Analysis
```sql
SELECT * FROM notifications
WHERE studentID = 1042 AND isRead = false
ORDER BY createdAt DESC;
```
**Is this query accurate?** Yes, it correctly filters unread notifications for a specific student and sorts them by recency.
**Why is this slow?** Without an index, PostgreSQL must perform a Full Table Scan (Sequential Scan) on a table with 5,000,000 rows just to find the rows matching `studentID = 1042`. Furthermore, sorting a large number of rows using `ORDER BY createdAt DESC` requires an expensive memory sort if not indexed.

### Changes and Computation Cost
**Change**: Add a composite B-Tree index on `(studentID, isRead, createdAt DESC)`.
```sql
CREATE INDEX idx_student_unread_recent ON notifications(studentID, isRead, createdAt DESC);
```
**Computation Cost**: With the index, the database can perform an Index Seek directly to the student's records, skip the read ones, and fetch them already in descending order. Time complexity drops from $O(N)$ (where $N$ is total table size) to $O(\log N + K)$ (where $K$ is the number of unread notifications for that student).

### "Index Every Column" Advice
**Is this advice effective?** No, it is a bad practice. 
**Why not?** Indexes speed up read operations but slow down write operations (`INSERT`, `UPDATE`, `DELETE`) because the database must update the index structure for every modification. Also, indexes consume significant disk space. You should only index columns that are frequently used in `WHERE`, `JOIN`, or `ORDER BY` clauses.

### Placement Query (Last 7 Days)
```sql
SELECT DISTINCT studentID
FROM notifications
WHERE notificationType = 'Placement' 
  AND createdAt >= NOW() - INTERVAL '7 days';
```

---

# Stage 4

### The Problem
Fetching notifications on every page load overwhelms the database with redundant queries, leading to degraded performance and bad user experience.

### Suggested Solutions
1. **Caching Layer (Redis)**:
   - **How it works**: Cache the user's recent notifications and unread count in Redis. When a page loads, the backend fetches data from Redis in sub-milliseconds rather than hitting PostgreSQL.
   - **Tradeoffs**: Faster read times, but introduces cache invalidation challenges. When a new notification is generated, both DB and Redis must be updated. Uses extra memory.
2. **WebSocket / Server-Sent Events (SSE)**:
   - **How it works**: Instead of the client polling or fetching on every page load, maintain a persistent connection. Fetch the initial state once upon login, and then let the server push new notifications to the client instantly.
   - **Tradeoffs**: Excellent UX and zero redundant database reads. However, maintaining thousands of persistent connections requires specialized infrastructure and scaling strategies (e.g., sticky sessions, Redis Pub/Sub backplane).

### Improvement Strategy
Implement **Caching with Redis** for the initial load, and **WebSockets** for real-time updates while the user remains on the site.

---

# Stage 5

### Shortcomings of the Synchronous "Notify All"
The provided pseudocode loops sequentially through 50,000 students and executes an email API, a DB insert, and a push notification synchronously.
**Shortcomings**:
1. **Time Complexity & Timeout**: Sending 50,000 emails synchronously will take hours. The HTTP request will timeout long before it finishes.
2. **Lack of Fault Tolerance**: As noted, if the email call fails for student 200, the loop might crash, leaving the remaining 49,800 students without notifications. There is no retry mechanism.
3. **Resource Blocking**: The server thread is completely blocked executing this loop.

### Redesigning the Implementation
We should decouple the request generation from the actual execution using a **Message Broker (e.g., RabbitMQ, Kafka, or AWS SQS)** and **Asynchronous Worker Services**.

**New Workflow**:
1. The HR clicks "Notify All". The API immediately acknowledges the request (HTTP 202 Accepted) and publishes a single "bulk_notification_event" to a message broker.
2. A dedicated Notification Worker picks up this event. Instead of doing everything itself, it splits the 50,000 students into chunks and publishes individual `send_notification` messages to a worker queue.
3. A pool of Worker nodes consumes the messages from the queue. For each message:
   - It performs the `save_to_db` operation.
   - It calls the `send_email` API.
   - It publishes the `push_to_app` event.
4. **Error Handling**: If `send_email` fails for a student, that specific message is placed back in the queue or moved to a Dead Letter Queue (DLQ) for retries, without affecting the processing of other students.

**Pseudocode**:
```python
# API Endpoint Handler
function notify_all_async(student_ids: array, message: string):
    publish_to_queue("bulk_task", {student_ids, message})
    return "Notification process started"

# Worker Node Consumer
function handle_bulk_task(payload):
    for student_id in payload.student_ids:
        publish_to_queue("individual_task", {student_id, message})

# Individual Worker Consumer (Scalable)
function handle_individual_task(task):
    try:
        save_to_db(task.student_id, task.message)
        send_email(task.student_id, task.message)
        push_to_app(task.student_id, task.message)
    except Error as e:
        move_to_dead_letter_queue(task, e)
```
