# Multi Drive

Manage multiple Google Drive and Mega accounts from a single interface with options to edit, delete, upload ,create files, and view remaining storage. and search folder from multiple account at one time.

<hr>
<br>

- <b>Setup Guide</b> - https://multi-drives.vercel.app/guide.html
- <b>Demo Video</b> - https://www.youtube.com/watch?v=NxMBscRX9ag
- <b>Demo Website</b> - https://multi-drives.vercel.app/ <br>(if you face any error try please using localhost for testing)
- <b>Need Help</b> - https://tejasmali.dev/contact.html 

- <b>Making Devlogs</b> - https://flavortown.hackclub.com/projects/19197 
<br> 
 
<hr>
<br>



![Homepage Screenshot Placeholder](./images/homepage.webp)


## Important Info

- Please use localhost for unlimited usage (hosted websites can have storage limits).
- Supports Google Drive and MEGA accounts
- Browse, upload, copy/move, create folders, and search across accounts
- Storage usage is shown per connected account
- MEGA delete is currently disabled (Google Drive delete works)
- Google Drive uploads have no size limit on the hosted site (the file goes straight from
  your browser to Google). **MEGA uploads on the hosted site are limited to about 4 MB** -
  use localhost for larger MEGA files
- If an account card shows "Reconnect", that account's access expired - connect it again






## Tech Stack
- HTML
- CSS
- JavaScript
- Vercel (Hosting)
- Upstash (for storing user cache)

# Setup
- For local hosting, you only need to install npm and run `npm start` in the terminal.
- Users need to set up Google OAuth to get credentials for using Google Drive.
- Create a testing web application in Google Cloud.
- Add your website URL or localhost URL to the allowed website/redirect settings.
- Add all required accounts to the testing audience, then use those credentials to log in.
- For MEGA accounts, just enter the account email and password to log in.

