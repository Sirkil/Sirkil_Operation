const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

// Initialize Firebase Admin for Token Verification
let credential;
if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  // Parse the JSON string from Render Environment Variables
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  credential = admin.credential.cert(serviceAccount);
} else {
  // Fallback to local file for development
  const serviceAccount = require('./serviceAccountKey.json');
  credential = admin.credential.cert(serviceAccount);
}

admin.initializeApp({ credential });

const app = express();
app.use(cors());
app.use(express.json());

// Serve Static Web Dashboard (Admin Panel at root /)
app.use(express.static(path.join(__dirname, 'public')));

// Serve Flutter Web App (User App at /app)
app.use('/app', express.static(path.join(__dirname, 'public/app')));

// Replace with your deployed Google Apps Script Web App URL
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyMo5lnJkdTmcS-GLzkhRyS87BzIgQwXSQm0mzrv_DxgqF0AKdr2iVqrz6mkJUhB3No/exec';

// Middleware to verify Firebase ID Token from the Flutter App
const verifyToken = async (req, res, next) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  if (!idToken) return res.status(401).send('Unauthorized: No token provided');

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Contains user email and uid
    next();
  } catch (error) {
    res.status(401).send('Unauthorized: Invalid token');
  }
};

// Endpoint: Submit a new purchase/update
app.post('/api/purchase', verifyToken, async (req, res) => {
  try {
    const { itemName, qty, piecePrice, status, invoiceImageBase64 } = req.body;
    const userEmail = req.user.email;
    const totalPrice = qty * piecePrice;

    // The Google Apps Script is expected to handle the base64 string and upload it to Google Drive
    // If invoiceImageBase64 is passed from the frontend, it will be forwarded as-is.
    const invoiceUrl = invoiceImageBase64 || "";

    // Prepare payload for Google Apps Script
    const payload = {
      action: "logPurchase",
      userEmail: userEmail,
      itemName: itemName,
      qty: qty,
      piecePrice: piecePrice,
      totalPrice: totalPrice,
      status: status,
      invoiceUrl: invoiceUrl
    };

    // Send data to Google Sheets via Apps Script
    const response = await axios.post(APPS_SCRIPT_URL, payload);

    res.status(200).json({ 
        message: 'Purchase logged successfully', 
        sheetResponse: response.data 
    });

  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});
// Endpoint: Create a new project (Admin Only)
app.post('/api/project/create', verifyToken, async (req, res) => {
  try {
    // Extract data sent from the Flutter Admin Dashboard
    const { projectName, initialItems } = req.body;
    
    // Extract the admin's email directly from the verified Firebase Auth token
    const adminEmail = req.user.email; 

    const authorizedAdmins = ['ahmed.tanany@sirkil.com', 'admin@sirkil.com', 'operations@sirkil.com', 'omar@sirkil.com', 'amr@sirkil.com'];

    // Optional: Add a strict role check to ensure only admins can trigger this.
    // You can hardcode your admin email or check a database role.
    if (!authorizedAdmins.includes(adminEmail)) {
       return res.status(403).send('Forbidden: Admin access required');
    }

    if (!projectName) {
      return res.status(400).send('Bad Request: projectName is required');
    }

    // Prepare the exact payload expected by the Google Apps Script doPost function
    const payload = {
      action: "createProject",
      projectName: projectName,
      adminEmail: adminEmail,
      // initialItems is an optional array of objects: [{itemName: "Laptop", qty: 2, assignedTo: "..."}]
      initialItems: initialItems || [] 
    };

    // Forward the request to your Google Apps Script Web App
    const response = await axios.post(APPS_SCRIPT_URL, payload);

    // Return the success confirmation back to the Flutter app
    res.status(200).json({ 
        message: `Project ${projectName} initiated successfully`, 
        sheetResponse: response.data 
    });

  } catch (error) {
    console.error('Error creating project tabs:', error);
    res.status(500).send('Internal Server Error: Failed to create project sheets');
  }
});

// Endpoint: Edit an existing item's quantity/price (Admin Only)
app.post('/api/project/edit-item', verifyToken, async (req, res) => {
  try {
    const { projectName, oldItemName, newItemName, qty, estPriceRange, assignedTo } = req.body;
    const adminEmail = req.user.email; 

    const authorizedAdmins = ['ahmed.tanany@sirkil.com', 'admin@sirkil.com', 'operations@sirkil.com', 'omar@sirkil.com', 'amr@sirkil.com'];

    if (!authorizedAdmins.includes(adminEmail)) {
       return res.status(403).send('Forbidden: Admin access required');
    }

    const payload = {
      action: "editItem",
      projectName,
      adminEmail,
      oldItemName,
      newItemName,
      qty,
      estPriceRange,
      assignedTo
    };

    const response = await axios.post(APPS_SCRIPT_URL, payload);
    res.status(200).json(response.data);

  } catch (error) {
    console.error('Error editing item:', error);
    res.status(500).send('Internal Server Error: Failed to edit item');
  }
});

// Endpoint to log "Add Money" Top-Ups
app.post('/api/add-money', verifyToken, async (req, res) => {
  try {
    const { amount, purpose, fromWhom, timeOfTransaction } = req.body;
    const userEmail = req.user.email; // From verified token

    const response = await axios.post(APPS_SCRIPT_URL, {
      action: 'addMoney',
      userEmail: userEmail,
      amount: amount,
      purpose: purpose,
      fromWhom: fromWhom,
      timeOfTransaction: timeOfTransaction
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error adding money:', error);
    res.status(500).json({ error: 'Failed to log added money' });
  }
});

// Endpoint to fetch all active projects and items from Google Sheets
app.get('/api/sync', verifyToken, async (req, res) => {
  try {
    const response = await axios.get(APPS_SCRIPT_URL);
    
    // Fetch users from Firebase Auth
    const listUsersResult = await admin.auth().listUsers(1000);
    const firebaseUsers = listUsersResult.users.map(userRecord => ({
      uid: userRecord.uid,
      email: userRecord.email,
      name: userRecord.displayName || 'Unknown',
      role: 'User' // Default role
    }));

    // Data from Google Sheets
    let sheetData = response.data;
    let sheetUsers = [];
    let sheetProjects = [];

    if (sheetData.status === 'success') {
       if (sheetData.data && Array.isArray(sheetData.data.projects)) {
          sheetProjects = sheetData.data.projects;
          sheetUsers = sheetData.data.users || [];
       } else {
          sheetProjects = Array.isArray(sheetData.data) ? sheetData.data : [];
          sheetUsers = sheetData.users || [];
       }
    }

    // Merge users: Use Firebase Users as the base, and attach balance if present in Google Sheets
    // The admin dashboard and flutter app expects an array of users with name, email, and balance
    const mergedUsers = firebaseUsers.map(fbUser => {
       const matchedSheetUser = sheetUsers.find(su => su.email === fbUser.email || (su.name && su.name.toLowerCase() === fbUser.name.toLowerCase()));
       return {
          ...fbUser,
          balance: matchedSheetUser ? matchedSheetUser.balance : 0
       };
    });

    res.status(200).json({
      status: 'success',
      data: {
        projects: sheetProjects,
        users: mergedUsers
      }
    });

  } catch (error) {
    console.error('Error syncing projects:', error);
    res.status(500).json({ error: 'Failed to sync projects from backend' });
  }
});

// Endpoint to securely proxy POST requests to Personal Apps Scripts
app.post('/api/proxy/post', verifyToken, async (req, res) => {
  try {
    const { scriptUrl, payload } = req.body;
    if (!scriptUrl) return res.status(400).send('Missing scriptUrl');
    
    const response = await axios.post(scriptUrl, payload);
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Error proxying POST to GAS:', error);
    res.status(500).json({ error: 'Proxy POST failed' });
  }
});

// Endpoint to securely proxy GET requests to Personal Apps Scripts
app.get('/api/proxy/get', verifyToken, async (req, res) => {
  try {
    const { scripturl } = req.headers;
    if (!scripturl) return res.status(400).send('Missing scripturl header');
    
    const response = await axios.get(scripturl);
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Error proxying GET to GAS:', error);
    res.status(500).json({ error: 'Proxy GET failed' });
  }
});

// Fallback route for Flutter Web App (Single Page Application routing support)
app.get(/^\/app.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/app', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Node.js middleware running on port ${PORT}`);
});