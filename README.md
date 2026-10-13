# OMR Assessment System — Phase 1

Print QR-coded OMR sheets, scan them with any phone camera, and collect scored results in one
shared Google Sheet per course. Built to the design document "OMR Assessment System — Design Document".

```
app/        Phone web app (PWA): Scan, Scans (history/sync), Print (PDF generator), Settings
  js/layout.js     sheet geometry — the single source of truth for printing and reading
  js/sheetpdf.js   draws sheets into a PDF (jsPDF)
  js/recognize.js  reads a photo: corner markers → perspective warp → QR → bubbles (OpenCV.js)
  js/store.js      sign-in, backend calls, offline queue (IndexedDB) and batched sync
  js/app.js        screens and camera auto-capture
  vendor/          pinned copies of OpenCV.js, jsQR, jsPDF, qrcode-generator (works offline)
backend/    Google Apps Script web app (Code.gs + appsscript.json)
tools/      tests: backend (mock Apps Script) and recognition (synthetic phone photos)
```

## How it fits together

1. A coordinator defines an exam in the course Google Sheet (questions, sets, marking).
2. An instructor opens **Print**, picks the exam and a count. The backend reserves a serial range
   (no two instructors ever get the same serials) and signs every sheet; the PDF is built on the phone or laptop.
3. Students fill only their enrollment number and answers. Paper code, exam and set are in the QR code.
4. Instructors open **Scan** and hold the phone over each sheet. It captures automatically when the
   sheet is steady, reads it in under a second, and shows a review screen only when something is unclear.
5. Scans queue on the phone and sync in batches of 20. The backend checks the signature, removes
   duplicates, scores against the right set's key and writes **Scans** and **Results** in the course Sheet.
   Any number of phones can scan the same exam at once.

---

## Setup (about 30 minutes, once)

Use one department Google account (for example `digital-village@thapar.edu` or an exam-cell account)
for steps 1–5. It will own the Registry and every course Sheet.

### 1. Create the backend script

1. Go to <https://script.google.com> → **New project**. Name it `OMR Backend`.
2. Replace the contents of `Code.gs` with `backend/Code.gs`.
3. **Project Settings** → tick *Show "appsscript.json" manifest file in editor*. Replace its contents
   with `backend/appsscript.json`.

### 2. Create a Google sign-in client ID

The phone app signs instructors in with Google; the backend checks that token on every request.

1. In **Project Settings** → *Google Cloud Platform (GCP) Project*, link a standard Cloud project
   (or create one at <https://console.cloud.google.com>).
2. In that Cloud project: **APIs & Services → OAuth consent screen** → User type **Internal**
   (only thapar.edu accounts) → fill the app name and support email.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application**.
   Under *Authorized JavaScript origins* add the address where you will host the app (step 6), e.g.
   `https://satyamyadav19125.github.io`. Copy the **Client ID**.
4. Back in Apps Script: **Project Settings → Script properties → Add** `CLIENT_ID` = that client ID.

### 3. Run setup once

In the editor choose `setup` → **Run** → approve the permissions. It creates a spreadsheet called
**OMR Registry** in the account's Drive and a 15-minute trigger that re-scores results whenever a
coordinator edits Exams, AnswerKey or Roster.

### 4. Create a course

Edit `createCourseExample()` at the bottom of `Code.gs`, for example:

```js
function createCourseExample() {
  createCourse('UCS802', 'Compiler Construction', 'coordinator@thapar.edu');
}
```

Run it. It creates **OMR – UCS802 Compiler Construction**, shares it with the coordinator as editor,
adds them as `coordinator` in the Instructors tab, and stores a signing secret for the course in
Script properties (never in the Sheet). Repeat for each course.

### 5. Deploy the web app

**Deploy → New deployment → Web app**

- Execute as: **Me**
- Who has access: **Anyone**

"Anyone" only makes the address reachable; every request still needs a valid Google sign-in from an
instructor listed on that course. Copy the **Web app URL** (ends in `/exec`).
After editing `Code.gs` later, use **Deploy → Manage deployments → Edit → Version: New** so the URL stays the same.

### 6. Host the phone app

The camera only works over HTTPS. The simplest free option is GitHub Pages:

1. Create a public repository, e.g. `omr-scanner`, and upload the contents of the `app/` folder.
2. **Settings → Pages** → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. The app is then at `https://satyamyadav19125.github.io/omr-scanner/`. Make sure the origin
   (`https://satyamyadav19125.github.io`) is in the OAuth client's authorized origins (step 2.3).

Firebase Hosting or any other HTTPS static host works the same way.
When you change files in `app/`, bump `VERSION` in `app/sw.js` so phones pick up the new version.

### 7. Connect each phone

Open the app on the phone (Chrome on Android, Safari on iPhone) → **Add to Home screen** →
**Settings**: paste the Web app URL and the Client ID → **Save** → **Sign in with Google** →
add the paper code (e.g. `UCS802`). The first open downloads the scanner engine (about 10 MB);
after that it opens instantly and scans offline.

Without a backend URL the app runs in **demo mode**: you can print unsigned sheets and scan them,
and results stay on the phone (export as CSV). Good for trying it out before setup.

---

## The course Google Sheet

Coordinators fill four tabs. The rest are written by the backend and are protected.

| Tab | Who edits | What goes in it |
| --- | --- | --- |
| Instructors | Coordinator | `Email`, `Role` (`coordinator` or `instructor`), `Name`. Only listed emails can print or scan. |
| Roster | Coordinator | `Enrollment` (9 digits), `Name`, `Group`. Paste from the ERP export. |
| Exams | Coordinator | `ExamId` (e.g. `MST-ODD26`, no `\|`), `Title`, `Date`, `Questions` (1–100), `Sets` (1–4), `MarksCorrect`, `PenaltyWrong` (0 for none), `MultipleRule` (`wrong` or `blank`). |
| AnswerKey | Coordinator | One row per exam and set: `ExamId`, `Set` (A–D), `Key`, optional `Marks`. |
| Issued | Backend | Serial ranges printed, by whom. |
| Scans | Backend | One row per scan: raw answer string, enrollment, corrections, who scanned, status. |
| Results | Backend | One row per student per exam: correct, wrong, blank, multiple, score, status. Rebuilt from Scans. |
| Review | Backend + coordinator | Sheets that need a decision (duplicate, unknown enrollment, bad signature…). |
| Audit | Backend | Every print, scan batch and re-grade. |

**Answer key format** — one character per question:

- `A`–`D` the correct option
- `[AC]` either A or C earns the marks
- `X` cancelled / bonus question: everyone gets the marks

Example for 10 questions: `ABCDA[BC]DXAB`. Optional `Marks` = comma-separated marks per question
(`1,1,2,2,1,1,1,1,2,2`) when questions carry different marks.

**Answer string in Scans** — `A`–`D` read, `-` blank, `*` more than one mark, `?` unclear and not
resolved on the phone. A result with any `?` stays *Pending review*.

Scanning can start before the key exists: results show *Awaiting key* and fill in automatically within
15 minutes of the key being entered (the same happens after any change to Exams, AnswerKey or Roster).
To re-score at once, run `refreshAllCourses` from the script editor.

---

## Exam-day checklist

1. Print at **100% / Actual size** on A4. Check the 100 mm line at the foot of one sheet with a ruler.
2. Tell students: blue/black ballpoint, fill circles completely, no ticks, nothing written near the
   four black squares or the QR code.
3. Scan on a flat, evenly lit surface. Keep all four black squares in view; avoid glare on the QR.
4. Check **Scans** on each phone shows nothing *Waiting* before leaving the hall.

---

## Tests

```
node tools/test_backend.js                              # 10 checks against a mock of Apps Script
node tools/test_recognition.js render <dir>             # writes sheets.pdf + layout.json
python3 tools/make_synthetic.py <dir>/sheets.pdf <dir>/layout.json <dir>/photos 40 1
node tools/test_recognition.js score <dir> <dir>/photos # reading accuracy
```

`make_synthetic.py` needs `opencv-python numpy` and `pdftoppm` (poppler). The synthetic photos vary
tilt (sometimes upside down), perspective, print scaling, lighting gradients, shadows, blur, JPEG
quality, phone resolution, ink colour and stray pen strokes near the corner squares.

Result on the final run (120 photos, 6,456 answers, 120 enrollment numbers):

| Measure | Result |
| --- | --- |
| Wrong reading not flagged | **0** |
| Clear fills, blanks, double marks read exactly | 100% |
| Faint or partial marks | read correctly, or flagged for the instructor to confirm |
| Sheets refused | 5, all with a corner square out of the frame (asks for a retake) |
| Time per sheet | about 0.25 s |

## Known limitations (Phase 1)

- **Ticks and crosses are read as blank**, as in most OMR systems: the reader looks for filled
  circles. The sheet tells students not to tick. Check this during the pilot with real pens.
- **Review decisions are recorded but not yet applied.** A coordinator can write a decision in the
  Review tab's Resolution column, but changing a scan's status from there is Phase 2. Until then,
  rescan with the right sheet, or correct the data and re-grade.
- Accuracy so far is on synthetic photos. Before a real exam, run the pilot from the design document
  (one quiz, checked fully by hand).
- One script-wide lock serialises writes. That allows roughly 400–1,200 sheets a minute across all
  courses, far above exam-hall rates.
