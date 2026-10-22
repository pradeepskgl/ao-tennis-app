// Builds the signed release APK and copies it to dist/ with its version in the name.
// Signing comes from android/keystore.properties (see mobile/README.md).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const android = path.join(__dirname, '..', 'android');
if (!fs.existsSync(path.join(android, 'keystore.properties'))) {
  console.error('android/keystore.properties is missing, so the APK cannot be signed. See mobile/README.md.');
  process.exit(1);
}

// Full path: some Windows shells don't run programs from the current folder.
const gradlew = path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
const r = spawnSync(`"${gradlew}" assembleRelease`, { cwd: android, stdio: 'inherit', shell: true });
if (r.status !== 0) process.exit(r.status || 1);

const gradle = fs.readFileSync(path.join(android, 'app', 'build.gradle'), 'utf8');
const version = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1] || 'dev';
const out = path.join(__dirname, '..', 'dist');
fs.mkdirSync(out, { recursive: true });
const dest = path.join(out, `ao-tennis-${version}.apk`);
fs.copyFileSync(path.join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'), dest);
console.log(`\nAPK ready: ${dest}`);
