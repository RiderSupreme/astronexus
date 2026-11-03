# starbase.nexus: setup (about 20 minutes)

The portal is one file, `starbase.html`, and runs on any static website. Scores are stored in Google's free Firebase database.

## 1. Create the Firebase project
1. Go to https://console.firebase.google.com and sign in with the AstroNexus Google account.
2. **Add project**, name it `astronexus-2026`, and turn Google Analytics off.
3. **Build > Authentication > Get started > Sign-in method:** enable **Email/Password** and **Anonymous** (team phones use Anonymous for check-in).
4. **Build > Firestore Database > Create database.** Pick the `europe-west` or `me-central` location and start in **production mode**.
5. **Firestore > Rules:** paste everything from `firestore.rules` and click **Publish**.

## 2. Create the 22 logins
Go to **Authentication > Users > Add user**. The email is the login ID plus `@starbase.astronexus26.app` (no emails are sent there).
The passwords are in **Starbase Nexus Logins.pdf** (kept outside this folder, do not upload it). Each group shares one login. Judges 1-2 score HelioScale, 3-4 LaunchX, 5-6 TerraFab, 7-8 Lost in Orbit.

| Login ID | Who uses it | What they see and do |
|---|---|---|
| `judge1` | Judge 1 · HelioScale | Scores HelioScale teams (only their own scores) |
| `judge2` | Judge 2 · HelioScale | Scores HelioScale teams (only their own scores) |
| `judge3` | Judge 3 · LaunchX | Scores LaunchX teams (only their own scores) |
| `judge4` | Judge 4 · LaunchX | Scores LaunchX teams (only their own scores) |
| `judge5` | Judge 5 · TerraFab | Scores TerraFab teams (only their own scores) |
| `judge6` | Judge 6 · TerraFab | Scores TerraFab teams (only their own scores) |
| `judge7` | Judge 7 · Lost in Orbit | Scores Lost in Orbit teams (only their own scores) |
| `judge8` | Judge 8 · Lost in Orbit | Scores Lost in Orbit teams (only their own scores) |
| `helioscale` | HelioScale event head | HelioScale attendance (can mark), live venue map |
| `launchx` | LaunchX event head | LaunchX attendance (can mark), live venue map |
| `terrafab` | TerraFab event head | TerraFab attendance (can mark), live venue map |
| `lostinorbit` | Lost in Orbit event head | Lost in Orbit attendance (can mark), live venue map |
| `logistics` | Team Logistics | All four events' attendance and team check-ins (can mark) |
| `volunteers` | Registration desk and volunteers | Roll call: present / absent for every student, fix names |
| `results1` | Results room | Live scores from both judges, averages, podiums, certificate list |
| `results2` | Results room | Same as `results1` |
| `coordinator1` | Event coordinator | Places and podiums for all four events, certificate list, tick "Certificates written" (no raw scores) |
| `coordinator2` | Event coordinator | Same as `coordinator1` |
| `coordinator3` | Event coordinator | Same as `coordinator1` |
| `coordinator4` | Event coordinator | Same as `coordinator1` |
| `core` | Core team and NMS teachers on duty | Live overview of all events (view only) |
| `admin` | Sriram | Everything, plus unlocking scores and creating team PINs |

Event heads can only mark students in their own event; the database rules enforce this.

## 3. Connect the page
1. **Project settings (gear icon) > General > Your apps > Web (`</>`)**, register the app as `starbase-nexus` and copy the `firebaseConfig` values.
2. Open `starbase.html`, find `const firebaseConfig = {` near the top of the script, and paste in `apiKey`, `authDomain`, `projectId` and `appId`.
3. Upload `starbase.html` to the top level of astronexusnms.com, so it opens at **https://astronexusnms.com/starbase.html**. Once the config is filled in, demo mode switches off.
4. **Authentication > Settings > Authorized domains:** add `astronexusnms.com` (and `www.astronexusnms.com`).

## 4. Before the event (rehearsal)
- On Tuesday 3 November, sign in as each of the 8 judges on the device they'll use and enter test scores. Sign in as `results1` in the results room and watch them appear.
- Then clear the test data: **Firestore > Data**, delete the `scores`, `status`, `certs`, `checkins` and `attendance` collections. Keep `pins`.

## On the day
- **Judges (2 per event):** each judge signs in with their own ID (e.g. `judge1`) and taps one level per criterion. No judge names or photos are shown. Scores save automatically, even if the connection drops, and sync when it's back. When finished, press **Submit final scores**, which locks that judge's scores.
- **Rubrics in the tool:** HelioScale 3 criteria (out of 90) · LaunchX 4 criteria: Altitude, Range, Structural Integrity, Teamwork & Launch Safety (out of 120) · TerraFab 3 criteria with 0/10/20/30 ticks plus Critics' Choice 0–10 (out of 100) · Lost in Orbit 3 criteria (out of 90).
- **Results room:** sign in as `results1` or `results2`. Each event shows Judge 1, Judge 2 and the **average**, which decides the ranking and the 1st/2nd/3rd podium. An event shows **FINAL** once both judges have submitted; write the certificates then and tick **Certificates written**.
- **Rolling Trophy:** events have different totals, so each school's best team score per event is turned into a percentage and the four are added (out of 400).
- **Mistake after submitting?** Sign in as `admin`, open the event and press **Unlock** next to that judge.
- **Backup:** keep printed score sheets at each venue in case the internet fails completely.

## Creating more logins (Staff logins tab)
Sign in as `admin` and open **Staff logins**. Type a login ID (lower case, e.g. `vol-reception`), keep or change the suggested password, pick the role and press **Create login**. It works straight away on any number of devices.
- Roles: Volunteers (registration roll call), Event heads (pick the event), Team Logistics (all events), Certificates & results, Core team & teachers (view only).
- The password is shown only once: write it down or send it privately.
- **Turn off** removes that login's access immediately (the database rules check it on every request).
- Judges keep their 8 fixed logins (`judge1` … `judge8`); school teams keep their Team ID + PIN.

## Paper sheets: judges and attendance (photo upload)
Print **Judge Score Sheets (bubble).pdf** (one page per judge, 8 pages, landscape) and **Attendance Sheets (bubble).pdf** (6 pages: HelioScale 2, LaunchX 2, TerraFab 1, Lost in Orbit 1). Print at **100% / Actual size**, single-sided, and do not resize.
1. Judges fill **one bubble per criterion** with a dark pen. TerraFab judges also fill one Critics' Choice bubble (0-10).
2. In starbase.nexus press **📷 Scan paper score sheet**, take a photo from straight above with all 4 black corner squares in view.
3. The sheet is read on the phone itself (no AI service, no internet needed for reading). The tool knows which sheet it is from the small squares at the top, and refuses a sheet that belongs to another judge.
4. The photo comes back with green rings on every bubble it read and orange rings where two bubbles look filled. Rows that need a look are highlighted: correct them in the table, then press **Save**.
5. Attendance: event heads, logistics and volunteers press **📷 Scan attendance sheet**. Event heads can only upload their own event's sheets.
6. Keep the paper sheets: they are the official backup.
Tips: avoid shadows across the page, don't fold the corners, and fill bubbles fully (a tick or a cross may be read as blank). If a photo fails, take it again closer and flatter.

## Team check-in with QR codes
1. Sign in as `admin` and open **Team logins**. Press **Create PINs for all teams**, then **Print slips**: one slip per team with its Team ID (e.g. HS-03) and a 4-digit PIN, grouped by school. Give the slips to each school's teacher, or email them the day before.
2. Print `Check-in QR Posters.pdf` (6 posters: Registration Desk, Champions Club, Canteen, TerraFab Arena, Soccer Field, Common Room (3rd floor)) and put each one up at its place. The posters point to **https://astronexusnms.com/starbase.html**, so upload `starbase.html` to the top level of the website with exactly that name.
3. On the day, a team (or its teacher) scans the poster, enters the Team ID and PIN once, and gets a gold tick. The phone remembers the team for the next scan.
   - At the **Registration Desk** this registers the team, so no paper sign-in is needed.
   - At a **venue** it marks the team as arrived, and warns them if they're at the wrong venue.
4. Event heads and Team Logistics sign in with their ID and see the **live map** (arrived / expected at each place) and a list per event: registered ✓ and at venue ✓ with times. Tap any status to mark a team manually (for a team without a phone) or undo a mistake.
5. The results room and admin see the same board in the **Check-in** tab.

## Why it's safe
The security rules (enforced by Firebase, not by the page) mean:
- each judge can only write scores for their own event, and only whole numbers from 0 to 30;
- no one can edit an event after it's submitted, except by admin unlock;
- only `results1`, `results2` and `admin` can see judges' scores; coordinators see places only on screen, and can tick certificates;
- a team can only check itself in with the correct PIN, and can't see any other team's data or anyone's scores;
- only admin can see the PINs;
- nobody without a login can read or write anything.
