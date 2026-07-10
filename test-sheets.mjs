import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';

const creds = JSON.parse(fs.readFileSync('./gcp-service-account.json'));
const auth = new GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const authClient = await auth.getClient();
const sheets = google.sheets({ version: 'v4', auth: authClient });

const SHEETS_ID = '10iSADuuxdZeXQKEvdfwsA2IOhz57FhkQ_Q3cSODnmkw';

const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: 'Hashtags!A1:D10'
});
console.log('Hashtags:', JSON.stringify(res.data.values, null, 2));
