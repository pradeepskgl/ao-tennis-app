# Mobile apps (Android and iOS)

The app is the website's frontend (`../public`) wrapped with [Capacitor](https://capacitorjs.com). It bundles the pages and calls the deployed server's API, set in `app.config.json`. You don't write separate app code: change `public/` and rebuild.

## One-time setup (Windows)

1. Install **Android Studio** (developer.android.com/studio). Open it once and let the setup wizard download the Android SDK.
2. Set two user environment variables (System Properties > Environment Variables), then open a new terminal:
   - `JAVA_HOME` = `C:\Program Files\Android\Android Studio\jbr`
   - `ANDROID_HOME` = `%LOCALAPPDATA%\Android\Sdk`
3. In this folder: `npm install`
4. **Create the signing key, once, and never lose it.** Every update must be signed with the same key; without it, people would have to uninstall the app to get a new version. Keep it outside the repo:
   ```powershell
   mkdir $HOME\keys
   & "$env:JAVA_HOME\bin\keytool" -genkeypair -v -keystore $HOME\keys\ao-tennis-upload.jks -alias ao-tennis -keyalg RSA -keysize 2048 -validity 10000
   ```
   It asks for a password and your name or organisation.
5. Create `android/keystore.properties` (gitignored). Use forward slashes in the path:
   ```properties
   storeFile=C:/Users/<you>/keys/ao-tennis-upload.jks
   storePassword=<password>
   keyAlias=ao-tennis
   keyPassword=<password>
   ```
6. **Back up** the `.jks` file and both passwords somewhere safe, such as a password manager or private cloud storage.

## Build the APK

```bash
npm run apk
```

This copies `public/` and `lib/scoring.js` into `www/`, syncs them into the Android project, builds a signed release APK, and writes `dist/ao-tennis-<version>.apk`. That single file installs on any phone running Android 7.0 or later.

Other commands:
- `npm run build`: refresh `www/` and both native projects (`build:android` / `build:ios` for one); run it before opening Android Studio or Xcode
- `npm run open`: open the project in Android Studio, where you can run it on an emulator or a USB-connected phone
- `npm run icons`: regenerate the Android and iOS icons and splash screens from `assets/logo.png` (source: `assets/logo.svg`)
- `API_BASE=http://192.168.x.x:3000 npm run build`: point a test build at a server on your PC instead of Render. Plain HTTP also needs `"cleartext": true` under `server` in `capacitor.config.json`, for testing only.

## Releasing a new version

1. In `android/app/build.gradle`, raise `versionCode` by 1 and set `versionName` (for example `1.0.1`).
2. `npm run apk`
3. Publish `dist/ao-tennis-<version>.apk`: on GitHub, go to Releases > Draft a new release, attach the file and publish. The website's `/android.html` page links to the latest release. If the repository is private, share the file through Google Drive instead and change that link.

Phones with an older version install the new APK over it, and users stay signed in.

## Installing on a phone

See `public/android.html`, served at `/android.html` on the website. In short: open the APK, allow "Install unknown apps" for the app you opened it with, tap Install, and if Play Protect warns, choose "Install anyway".

## iOS

iPhones and iPads can't install an app from a file the way Android installs an APK. An iOS app reaches people only through **TestFlight** (Apple's beta app: up to 10,000 testers through a public link, with each build valid for 90 days) or the **App Store**. Both need a paid Apple Developer account, and building needs macOS. This project builds in the cloud with Codemagic, so you don't need a Mac.

The iOS project is in `ios/App`. It is iPhone and iPad, iOS 16 or later, and uses Swift Package Manager, so no CocoaPods. `codemagic.yaml` at the repo root holds the build steps.

### One-time setup

1. Join the **Apple Developer Program** ($99/year) at developer.apple.com. Identity checks can take a day or two.
2. In **App Store Connect** (appstoreconnect.apple.com), go to Apps > + > New App: platform iOS, name "AO Tennis Score Tracker", bundle ID `com.pradeepskgl.aotennis` (register it first under Certificates, Identifiers & Profiles > Identifiers if it isn't offered), SKU `ao-tennis`.
3. In App Store Connect, go to Users and Access > Integrations > App Store Connect API and generate a key with the **App Manager** role. Download the `.p8` file (you can only download it once) and note the Issuer ID and Key ID.
4. Sign up at **codemagic.io** with GitHub and add this repository. Under Team settings > Integrations > Developer Portal, add the API key and name it exactly `AO Tennis App Store key`, the name `codemagic.yaml` uses.
5. In Codemagic, open the app's code signing settings, choose iOS certificates, and let Codemagic generate an **Apple Distribution** certificate. It then creates the App Store provisioning profile for the bundle ID automatically.

### Build and test

1. Commit and push. In Codemagic, start the **iOS build to TestFlight** workflow. It bundles `public/`, builds and signs the app, and uploads it, which takes about 15–25 minutes.
2. In App Store Connect, open TestFlight. The build appears after Apple's processing, about 10–30 minutes later. Add yourself as an internal tester, install **TestFlight** from the App Store on your iPhone, and test.
3. To share more widely, create an external testing group and turn on its public link. The first external build goes through a short beta review.

### Releasing on the App Store

- **Version:** for a new release, change `MARKETING_VERSION` (for example `1.0.1`) in `ios/App/App.xcodeproj/project.pbxproj`, or in Xcode under App target > General > Version. The build number goes up automatically on each Codemagic build.
- **Listing:** description, keywords, support URL, privacy policy URL `https://ao-tennis-app.onrender.com/privacy.html`, screenshots for 6.9" iPhone and 13" iPad (the app also supports iPad), and Price: Free.
- **App Privacy:** under "Data Not Used to Track You", declare User ID (the scorer's username) for app functionality. There are no ads, no tracking and no analytics.
- **Review notes:** give a demo **scorer** login and a tournament to score. Mention that the server can take up to a minute to wake if it has been idle.
- **Review risk:** Apple can reject apps that look like a repackaged website (guideline 4.2). It helps that the app bundles its own interface, updates scores live, and uses the native share sheet for exports. If it's rejected anyway, push notifications for match results are the usual next step.
- **The name "AO":** Apple rejects names that suggest a link to a brand you don't own, such as the Australian Open. If "AO" isn't your own club or brand, choose a different App Store name.

### With a Mac (optional)

`npm install && npm run build:ios && npx cap open ios`. Then, in Xcode, select your team under Signing & Capabilities and run the app on a simulator or a connected iPhone.

## Google Play later

Build an App Bundle instead: run `cd android && gradlew.bat bundleRelease`, which writes `app/build/outputs/bundle/release/app-release.aab`. When Play Console offers Play App Signing, choose **"Use my own app signing key"** and upload this same keystore. Then the Play version updates over sideloaded installs without an uninstall.
