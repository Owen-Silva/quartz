Quartz VERSION for Windows 11 (x64).

**Install:** download `Quartz-Setup.exe` below and run it. It installs for your user only, into
`%LOCALAPPDATA%\Programs\Quartz`, with no administrator prompt, and adds Quartz to the Start Menu.

**Windows SmartScreen will warn** ("Windows protected your PC"), because the installer is not
code-signed. Click **More info**, check that the app is `Quartz-Setup.exe`, then **Run anyway**.

**Updates:** Quartz checks this page's latest release and, when a newer one is out, offers
"Download the installer". Run the new installer over the old copy: your tabs, logins and settings stay.

**Uninstall:** Settings > Apps > Installed apps > Quartz > Uninstall. Your profile in
`%APPDATA%\Quartz` is kept; delete that folder too to remove everything.

**Protected video (Widevine):** this build is not signed for streaming services, so Netflix,
Disney+, Prime Video and similar refuse to play in it. Quartz says so on those sites, with an
"Open in Edge" button.

Claude tabs need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed.

Source: this release's commit, GPL-3.0-only. Running from a git clone still works as before (see the README).
