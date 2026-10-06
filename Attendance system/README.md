# Jyothi Technologies Batch-2 (Juniors)

A small server-rendered attendance system for JIT. It uses Node.js 24 and its built-in SQLite driver; there are no package dependencies.

## Run locally

```powershell
npm start
```

Open <http://localhost:3000/> for the portal selector, <http://localhost:3000/student> for the student portal, and <http://localhost:3000/admin> for the admin console. The server creates `data/attendance.sqlite` on its first start. Set `PORT`, `DATA_DIR`, or `DB_PATH` to use another port or persistent storage volume. For an HTTPS deployment, set `COOKIE_SECURE=1` behind a trusted TLS terminator. Browser geolocation is available on HTTPS and localhost.

## Deploy to Cloud Run

From the project folder, with the Google Cloud CLI installed and authenticated:

```powershell
gcloud run deploy jit-college-attendance --source . --region asia-southeast1 --allow-unauthenticated
```

Cloud Run uses the `start` script in `package.json`. The default SQLite file is local to the container and may not survive instance replacement; configure `DB_PATH` to a supported persistent mounted volume before relying on production attendance records.

## Initial accounts

Student usernames are their first names, lowercase. The initial password is the first four letters of each name, lowercase, followed by `@123`.

| Role | Username | Initial password |
| --- | --- | --- |
| Student | `keerthan` | `keer@123` |
| Student | `sinchana` | `sinc@123` |
| Student | `megha` | `megh@123` |
| Student | `lekha` | `lekh@123` |
| Student | `tanushri` | `tanu@123` |
| Student | `mounika` | `moun@123` |
| Student | `sanjana` | `sanj@123` |
| Student | `gowthami` | `gowt@123` |
| Student | `nithin` | `nith@123` |
| Admin | `admin` | `admin@123` |
| Admin | `domodar` | `damo@123` |
| Admin | `karan kumar` | `karan@123` |

The Karan Kumar password was not specified, so `karan@123` is an initial password chosen for this implementation. These are starter credentials, not suitable for a public deployment. The app stores salted scrypt password hashes, not plaintext passwords. The initial users are inserted only when missing; changing a password requires an administrator-managed credential update before deployment.

## Attendance rules

All rules are checked by the server in `Asia/Kolkata`, regardless of the browser clock. Day in is allowed strictly after 8:55 AM and before 4:00 PM; day out is allowed strictly after 4:00 PM. Short break actions are allowed from 10:20 to 10:30 AM, and lunch actions from 1:00 to 2:00 PM. Each break can be recorded once per day. If a break is started but not ended by the end of its window, the server records its end at the scheduled boundary.

Day in requires browser location permission and a location within 500 m of 12°50′32.4″N, 77°30′45.0″E. Both lunch actions also require a location within 2 km. The short break does not require location. Location coordinates and measured campus distance are kept with attendance records.

The calendar percentage counts recorded attendance against elapsed weekdays (Monday-Friday); it does not account for holidays or institution-specific schedules.

## Storage and operations

SQLite is the centralized SQL database for this single-server app. Profiles, attendance, break records, geofence measurements, and an append-only attendance event log are stored in it. The app has no record-expiration job, so it does not automatically delete data after five years. To retain data for at least five years in use, deploy the database on persistent storage, schedule and test off-host database backups, restrict access to the storage, and retain backups for the required period. A local database file alone cannot protect against disk loss. SQLite is suitable for this single app instance; use a managed PostgreSQL service and shared sessions if the application is deployed across multiple server instances.

Students can update their display name, email, and phone number; the original student ID remains unchanged. Admins can review any selected date and export all attendance rows as CSV. The database itself remains on the server.
