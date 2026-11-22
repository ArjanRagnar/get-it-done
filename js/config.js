// Public settings for the app. The client ID is not a secret.
window.GID_CONFIG = {
  clientId: '418332786756-nve4r07aka2jjd7jr4hbb37hl843k03c.apps.googleusercontent.com',
  scopes: [
    'https://www.googleapis.com/auth/drive.appdata',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/gmail.send'
  ].join(' '),
  dataFile: 'get-it-done.json',
  version: '0.3.2',
  stage: 2 // 1: sign-in, Drive storage, brain dump, buckets, board. Google Calendar/Tasks writes come in stage 2, emails in stage 3.
};
