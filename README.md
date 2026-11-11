# Family Control Room: setup guide (iPad)

This folder is your own copy of the Control Room. It runs on two free services:

- **Firebase** (by Google) handles sign-in and stores your tasks, notes and files. A security rule lets only your two accounts read or write anything.
- **GitHub Pages** hosts the app so you can open it at a web address and add it to your Home Screen.

Everything below works in **Safari on an iPad**. Allow about 45 minutes, once. Neither service asks for a credit card.

> **Tip:** Open the Notes app in Split View next to Safari (or just switch back and forth). You'll copy a few values into a note along the way.

---

## Step 1: Unzip the folder

1. Save **control-room.zip** to the Files app (tap it in Claude → Share → Save to Files).
2. In Files, tap the zip once. A **control-room** folder appears next to it with 13 files inside.
3. Save **control-room-export.json** (your existing tasks) to Files too. You'll import it at the end.

## Step 2: Create the Firebase project

1. In Safari, go to **console.firebase.google.com** and sign in with your Google account.
2. Tap **Create a project** (or **Add project**). Name it something like `family-control-room`.
3. When it asks about Google Analytics, turn it **off**.
4. Stay on the free **Spark** plan.

## Step 3: Register the app and copy its settings

1. On the project's home page, tap the **web** icon (`</>`) to add a web app.
2. Nickname it `Control Room`. **Leave "Firebase Hosting" unchecked.** Tap **Register app**.
3. Firebase shows code containing `const firebaseConfig = { apiKey: "...", ... }`. Select the part from `{` to `}` and **copy it into your note**. You'll paste it into the app's settings in Step 7.

> These values aren't passwords. They only tell the app which Firebase project to use. The security rules in Step 6 are what keep your data private.

## Step 4: Turn on email sign-in

1. In the left menu (tap ☰ if it's hidden), open **Build → Authentication** and tap **Get started**.
2. Under **Sign-in method**, choose **Email/Password**, switch on the first toggle, and tap **Save**. Leave "Email link" off.

## Step 5: Create your two accounts

1. In Authentication, open the **Users** tab and tap **Add user**.
2. Enter your email and a password, then tap **Add user**. Do the same for your wife.
   - Use real addresses, because "Forgot password?" sends a reset link there.
   - She can change her password later in the app (tap her name → Change password).
3. Each person has a **User UID**: a long string of letters and numbers. Tap the copy icon next to each and **paste both into your note**.

## Step 6: Create the database and lock it down

1. In the left menu, open **Build → Firestore Database** and tap **Create database**.
2. Pick a location close to home, such as **northamerica-northeast2 (Toronto)**. You can't change it later.
3. Choose **Start in production mode**, then **Create**.
4. Open the **Rules** tab and delete everything in the editor.
5. Paste in the rules below, replacing the two placeholders with your two UIDs. Keep the single quote marks.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isFamily() {
      return request.auth != null && request.auth.uid in [
        'PASTE_FIRST_UID_HERE',
        'PASTE_SECOND_UID_HERE'
      ];
    }
    match /{document=**} {
      allow read, write: if isFamily();
    }
  }
}
```

6. Tap **Publish**.

Now only those two accounts can see or change anything.

## Step 7: Put the app online with GitHub Pages

**7a. Create a GitHub account and a repository**

1. Go to **github.com** and sign up for a free account. Your username becomes part of the app's address, for example `higgins-family` gives `higgins-family.github.io`.
2. Tap **+** (top right) → **New repository**. Name it `control-room`, choose **Public**, and tap **Create repository**.
   - Public means the app's code can be seen, but not your data. That stays locked in Firebase behind your accounts.

**7b. Upload the files**

1. On the new repository page, tap the link **uploading an existing file**.
2. Tap **choose your files**, then **Browse**, and open the **control-room** folder in Files.
3. Tap **Select** (top right), select **all 13 files**, and tap **Open**.
4. Scroll down and tap **Commit changes**.

**7c. Add your Firebase settings**

1. In the repository's file list, tap **config.js**, then the **pencil icon** (Edit).
2. Replace each `PASTE_...` value with the matching value from your note (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`). Keep the quote marks.
3. Tap **Commit changes…**, then **Commit changes** again.

**7d. Turn on the website**

1. In the repository, tap **Settings** (if you can't see it, tap ⋯ first) → **Pages** in the left menu.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**, then **Branch** to **main** and **/ (root)**. Tap **Save**.
3. Wait a minute or two and refresh. The page shows your address, for example `https://higgins-family.github.io/control-room/`. Copy it into your note.

## Step 8: Tell Firebase about the address

1. Back in Firebase, open **Authentication → Settings → Authorized domains**.
2. Tap **Add domain** and enter just the host name, for example `higgins-family.github.io` (no `https://`, no `/control-room`).

## Step 9: Install it and bring in your tasks

On your iPad first:

1. Open your app address in **Safari** (or Chrome).
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open the **Control Room** icon on your Home Screen and sign in.
4. Tap your name (top right) → **Import** → **Choose file**, and pick **control-room-export.json**. Leave "Items in the file were made by me" ticked.
5. Your 7 tasks, their history and your 9 to-dos appear. Importing the same file again won't create duplicates.

Then on your iPhone and your wife's devices, do steps 1 to 3 with each person's own account. Everything is already there.

> On iPhone and iPad, a Home Screen app keeps its own sign-in, separate from Safari. Sign in inside the Home Screen app once and it remembers you.

---

## Optional extra protection (recommended)

1. **Restrict the API key to your site.** Go to **console.cloud.google.com**, choose your Firebase project at the top, then **APIs & Services → Credentials**. Tap **Browser key (auto created by Firebase)**. Under **Application restrictions** choose **Websites**, add `https://YOUR-USERNAME.github.io/*`, and **Save**.
2. **Turn off new sign-ups.** In Firebase **Authentication → Settings → User actions**, untick **Enable create (sign-up)** if you see that option.
3. **Use strong, unique passwords** for Google, GitHub and both Control Room accounts, and turn on 2-step verification for Google and GitHub.

## Everyday use

- **Shared data:** a change on one device shows up on the others within a second or two.
- **Offline:** the app opens and works without a connection, and syncs when you're back online. A photo or PDF you haven't opened before needs a connection the first time.
- **Files:** photos are shrunk automatically. Each file can be up to 20 MB, and the free plan holds 1 GB in total.
- **Backups:** tap your name → **Save a backup** now and then, and keep the file in iCloud Drive. It holds everything except the photos and PDFs themselves.

## Updating the app later

If you get a new version of the files: open your repository, tap **Add file → Upload files**, and upload every new file **except config.js**, so your settings stay. Tap **Commit changes**. The site updates within a couple of minutes. Close and reopen the app twice to pick it up. Your data isn't affected.

## Using a computer instead

If you'd rather use a computer, Netlify works too. Edit `config.js` in a plain text editor, go to **app.netlify.com** → **Add new site → Deploy manually**, and drag the folder in. Then add the `….netlify.app` address in Step 8 instead.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Almost ready… not connected to Firebase yet" | `config.js` still has `PASTE_` values. Redo Step 7c, wait two minutes, reopen. |
| GitHub shows a 404 page | Pages takes a few minutes the first time. Check Step 7d, and make sure the address ends in `/control-room/`. |
| "That email and password do not match" | Check the account in Firebase → Authentication → Users, or tap "Forgot password?". |
| "This account does not have access" | That account's UID isn't in the rules. Recheck Step 6 and tap Publish. |
| "Your tasks could not load" | The database may not exist yet (Step 6), or there's no connection. |
| The Home Screen icon opens an old version | Close the app completely and open it again while online. |

## What's in this folder

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app itself |
| `config.js` | **Your Firebase settings: edit this one** |
| `firestore.rules` | A copy of the security rules from Step 6 |
| `manifest.webmanifest`, `sw.js`, `*.png` | What makes it installable and work offline |
| `_headers` | Extra security settings (used only on Netlify) |
