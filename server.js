require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

// Initialize Firebase Admin for Token Verification
let credential;
if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  credential = admin.credential.cert(serviceAccount);
} else {
  const serviceAccount = require('./serviceAccountKey.json');
  credential = admin.credential.cert(serviceAccount);
}

admin.initializeApp({ credential });
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve Static Web Dashboard (Admin Panel at root /)
app.use(express.static(path.join(__dirname, 'public')));

// Serve Flutter Web App (User App at /app)
app.use('/app', express.static(path.join(__dirname, 'public/app')));

// Replace with your deployed Google Apps Script Web App URL
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxvrMNBwbwJsQI66REwhbJS71qsitqf5r_ykLU6qnvM4SBRao4wqBTOhCL7L9_Osfjf0w/exec';

// All authorized admin accounts — used for access control and notifications
const ADMIN_EMAILS = ['ahmed.tanany@sirkil.com', 'admin@sirkil.com', 'operations@sirkil.com', 'omar@sirkil.com', 'amr@sirkil.com', 'farah.ashraf@sirkil.com'];

// Middleware to verify Firebase ID Token from the Flutter App
const verifyToken = async (req, res, next) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  if (!idToken) return res.status(401).send('Unauthorized: No token provided');

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(401).send('Unauthorized: Invalid token');
  }
};

// Helper for Firestore item updates
async function updateFirestoreItem(projectName, oldItemName, updates) {
  try {
    const itemsRef = db.collection('projects').doc(projectName).collection('items');
    const snapshot = await itemsRef.where('name', '==', oldItemName).get();
    if (snapshot.empty) return;

    const batch = db.batch();
    snapshot.forEach(doc => {
      batch.update(doc.ref, updates);
    });
    await batch.commit();
  } catch(e) { console.error('Firestore Update Error:', e); }
}

// Endpoint: Submit a new purchase/update (legacy)
app.post('/api/purchase', verifyToken, async (req, res) => {
  try {
    const { itemName, qty, piecePrice, status, invoiceImageBase64 } = req.body;
    const userEmail = req.user.email;
    const totalPrice = qty * piecePrice;
    const invoiceUrl = invoiceImageBase64 || "";

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

    const response = await axios.post(APPS_SCRIPT_URL, payload);
    res.status(200).json({ message: 'Purchase logged successfully', sheetResponse: response.data });
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint: Create a new project (Admin Only)
// Change 3: preserveActive=true means we won't overwrite isActive if already true
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/project/create', verifyToken, async (req, res) => {
  try {
    const { projectName, initialItems, preserveActive } = req.body;
    const adminEmail = req.user.email;

    const authorizedAdmins = ['ahmed.tanany@sirkil.com', 'admin@sirkil.com', 'operations@sirkil.com', 'omar@sirkil.com', 'amr@sirkil.com', "farah.ashraf@sirkil.com"];

    if (!authorizedAdmins.includes(adminEmail)) {
       return res.status(403).send('Forbidden: Admin access required');
    }

    if (!projectName) {
      return res.status(400).send('Bad Request: projectName is required');
    }

    const payload = {
      action: "createProject",
      projectName: projectName,
      adminEmail: adminEmail,
      initialItems: initialItems || []
    };

    const response = await axios.post(APPS_SCRIPT_URL, payload);
    res.status(200).json({
        message: `Project ${projectName} initiated successfully`,
        sheetResponse: response.data
    });

    // Dual-write to Firestore
    // Change 3: Check if project already exists and is active — don't override isActive
    try {
      const projectRef = db.collection('projects').doc(projectName);
      const existingDoc = await projectRef.get();
      
      let isActiveValue = true; // New projects start as active
      if (existingDoc.exists && preserveActive) {
        // Preserve existing active state
        isActiveValue = existingDoc.data().isActive ?? true;
      }

      await projectRef.set({
        name: projectName,
        isActive: isActiveValue,
        isArchived: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }); // Use merge so we don't wipe existing data

      if (initialItems && initialItems.length > 0) {
        const batch = db.batch();
        initialItems.forEach(item => {
          const docId = (item.itemName || '').replace(/\//g, '-');
          const itemRef = projectRef.collection('items').doc(docId);
          batch.set(itemRef, {
            name: item.itemName,
            qty: parseInt(item.qty) || 1,
            estPriceRange: item.estPriceRange || (item.estPriceFrom && item.estPriceTo ? `$${item.estPriceFrom}-$${item.estPriceTo}` : ''),
            estPriceFrom: parseFloat(item.estPriceFrom) || 0,
            estPriceTo: parseFloat(item.estPriceTo) || 0,
            referenceImageBase64: item.referenceImageBase64 || '',
            status: 'Searching',
            // Change 7/extra req: if admin pre-assigns item, set it so user sees in Assigned tab
            assignedTo: item.assignedTo || '',
            piecePrice: 0,
            totalPrice: 0
          });
        });
        await batch.commit();
      }
    } catch (fsError) {
      console.error('Firestore project creation error:', fsError);
    }

  } catch (error) {
    console.error('Error creating project tabs:', error);
    res.status(500).send('Internal Server Error: Failed to create project sheets');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint: Edit an existing item/claim item/update status
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/project/edit-item', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;

    const payload = {
      ...req.body,
      action: "editItem",
      adminEmail: userEmail
    };

    const response = await axios.post(APPS_SCRIPT_URL, payload);
    res.status(200).json(response.data);

    // Dual-write to Firestore
    if (!req.body.skipFirestore) {
      const { projectName, oldItemName, newItemName, qty, estPriceRange, assignedTo, status } = req.body;
      let updates = {};
      if (newItemName !== undefined) updates.name = newItemName;
      if (qty !== undefined) updates.qty = parseInt(qty);
      if (estPriceRange !== undefined) updates.estPriceRange = estPriceRange;
      if (assignedTo !== undefined) updates.assignedTo = assignedTo;
      if (status !== undefined) updates.status = status;
      
      if (Object.keys(updates).length > 0) {
        await updateFirestoreItem(projectName, oldItemName || req.body.itemName, updates);
      }
    }

  } catch (error) {
    console.error('Error editing item:', error);
    res.status(500).send('Internal Server Error: Failed to edit item');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint: Log a purchase and final price to the Master Sheet
// Change 9: imageBase64 is sent as base64 — GAS will upload it to Drive
// Folder structure enforced in GAS: projectName/itemName/invoice/
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/project/log-purchase', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;

    // Send base64 image directly to GAS so it can upload to Drive
    const payload = {
      ...req.body,
      action: "logPurchase",
      adminEmail: userEmail,
      userEmail: userEmail,
      // imageBase64 forwarded as-is (GAS will handle the Drive upload)
    };

    const response = await axios.post(APPS_SCRIPT_URL, payload);
    res.status(200).json(response.data);

    // Dual-write to Firestore
    if (!req.body.skipFirestore) {
      const { projectName, itemName, qty, piecePrice, totalPrice, status, invoiceUrl } = req.body;
      await updateFirestoreItem(projectName, itemName, {
        qty: parseInt(qty) || 0,
        piecePrice: parseFloat(piecePrice) || 0,
        totalPrice: parseFloat(totalPrice) || 0,
        status: status || 'Bought',
        invoiceUrl: invoiceUrl || ''
      });

      if (totalPrice) {
        const userRef = db.collection('users').doc(userEmail);
        await userRef.set({ balance: admin.firestore.FieldValue.increment(-parseFloat(totalPrice)) }, { merge: true });
      }
    }

    // Issue #6: Also post to Stock Sheet so the item is added to inventory when bought
    const STOCK_SCRIPT_URL = process.env.STOCK_SCRIPT_URL;
    if (STOCK_SCRIPT_URL && req.body.itemName && !req.body.skipStockSync) {
      try {
        const stockCategory = req.body.stockCategory || 'General';
        const stockPayload = {
          type: 'ADD',
          cart: [{ name: req.body.itemName, qty: parseInt(req.body.qty) || 1, category: stockCategory }],
          user: { name: userEmail, email: userEmail },
          purpose: `Purchased for project: ${req.body.projectName || 'Unknown'}`
        };
        await axios.post(STOCK_SCRIPT_URL, stockPayload);
      } catch (stockErr) {
        console.error('Stock sheet sync error (non-fatal):', stockErr.message);
      }
    }

  } catch (error) {
    console.error('Error logging purchase:', error);
    res.status(500).send('Internal Server Error: Failed to log purchase');
  }
});

// Endpoint to log "Add Money" Top-Ups
app.post('/api/add-money', verifyToken, async (req, res) => {
  try {
    const { amount, purpose, fromWhom, timeOfTransaction } = req.body;
    const userEmail = req.user.email;

    const response = await axios.post(APPS_SCRIPT_URL, {
      action: 'addMoney',
      userEmail: userEmail,
      amount: amount,
      purpose: purpose,
      fromWhom: fromWhom,
      timeOfTransaction: timeOfTransaction
    });

    res.json(response.data);

    if (!req.body.skipFirestore) {
      if (amount) {
        const userRef = db.collection('users').doc(userEmail);
        await userRef.set({ balance: admin.firestore.FieldValue.increment(parseFloat(amount)) }, { merge: true });
      }
    }
  } catch (error) {
    console.error('Error adding money:', error);
    res.status(500).json({ error: 'Failed to log added money' });
  }
});

// Endpoint to fetch all active projects and items from Google Sheets
app.get('/api/sync', verifyToken, async (req, res) => {
  try {
    const response = await axios.get(APPS_SCRIPT_URL);
    
    const listUsersResult = await admin.auth().listUsers(1000);
    const firebaseUsers = listUsersResult.users.map(userRecord => ({
      uid: userRecord.uid,
      email: userRecord.email,
      name: userRecord.displayName || 'Unknown',
      role: 'User'
    }));

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

// Endpoint: Toggle project active status
app.post('/api/project/toggle-active', verifyToken, async (req, res) => {
  try {
    const { projectName, isActive } = req.body;
    if (!projectName) return res.status(400).send('Missing projectName');
    await db.collection('projects').doc(projectName).set({ isActive: !!isActive }, { merge: true });
    res.status(200).json({ status: 'success', isActive: !!isActive });
  } catch (error) {
    console.error('Error toggling project active:', error);
    res.status(500).json({ error: 'Failed to toggle project active status' });
  }
});

// Endpoint: Archive a project
app.post('/api/project/archive', verifyToken, async (req, res) => {
  try {
    const { projectName } = req.body;
    if (!projectName) return res.status(400).send('Missing projectName');
    await db.collection('projects').doc(projectName).set({ isActive: false, isArchived: true }, { merge: true });
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error archiving project:', error);
    res.status(500).json({ error: 'Failed to archive project' });
  }
});

// Endpoint: Unarchive a project
app.post('/api/project/unarchive', verifyToken, async (req, res) => {
  try {
    const { projectName } = req.body;
    if (!projectName) return res.status(400).send('Missing projectName');
    await db.collection('projects').doc(projectName).set({ isArchived: false, isActive: false }, { merge: true });
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error unarchiving project:', error);
    res.status(500).json({ error: 'Failed to unarchive project' });
  }
});

// Endpoint: Delete a project
app.delete('/api/project/delete', verifyToken, async (req, res) => {
  try {
    const adminEmail = req.user.email;
    const authorizedAdmins = ['ahmed.tanany@sirkil.com', 'admin@sirkil.com', 'operations@sirkil.com', 'omar@sirkil.com', 'amr@sirkil.com', "farah.ashraf@sirkil.com"];
    if (!authorizedAdmins.includes(adminEmail)) return res.status(403).send('Forbidden');

    const { projectName } = req.body;
    if (!projectName) return res.status(400).send('Missing projectName');

    const itemsRef = db.collection('projects').doc(projectName).collection('items');
    const snapshot = await itemsRef.get();
    const batch = db.batch();
    snapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    await db.collection('projects').doc(projectName).delete();

    try {
      await axios.post(APPS_SCRIPT_URL, { action: 'deleteProject', projectName, adminEmail });
    } catch (_) {}

    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint: Rename a project (Change 10)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/project/rename', verifyToken, async (req, res) => {
  try {
    const adminEmail = req.user.email;
    const authorizedAdmins = ['ahmed.tanany@sirkil.com', 'admin@sirkil.com', 'operations@sirkil.com', 'omar@sirkil.com', 'amr@sirkil.com', "farah.ashraf@sirkil.com"];
    if (!authorizedAdmins.includes(adminEmail)) return res.status(403).send('Forbidden');

    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).send('Missing oldName or newName');

    const oldRef = db.collection('projects').doc(oldName);
    const newRef = db.collection('projects').doc(newName);

    // 1. Copy project doc
    const oldDoc = await oldRef.get();
    if (!oldDoc.exists) return res.status(404).send('Project not found');
    await newRef.set({ ...oldDoc.data(), name: newName }, { merge: false });

    // 2. Copy all items
    const itemsSnapshot = await oldRef.collection('items').get();
    if (!itemsSnapshot.empty) {
      const batch = db.batch();
      itemsSnapshot.forEach(doc => {
        const newItemRef = newRef.collection('items').doc(doc.id);
        batch.set(newItemRef, { ...doc.data(), projectName: newName });
      });
      await batch.commit();
    }

    // 3. Delete old project + items
    const delBatch = db.batch();
    itemsSnapshot.forEach(doc => delBatch.delete(doc.ref));
    delBatch.delete(oldRef);
    await delBatch.commit();

    // 4. Notify GAS to rename the sheet tab
    try {
      await axios.post(APPS_SCRIPT_URL, {
        action: 'renameProject',
        oldName,
        newName,
        adminEmail
      });
    } catch (_) {}

    res.status(200).json({ status: 'success', message: `Project renamed from "${oldName}" to "${newName}"` });
  } catch (error) {
    console.error('Error renaming project:', error);
    res.status(500).json({ error: 'Failed to rename project' });
  }
});

// Endpoint: Log a Deposit
app.post('/api/project/log-deposit', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const payload = {
      ...req.body,
      action: "logDeposit",
      userEmail: userEmail
    };

    const response = await axios.post(APPS_SCRIPT_URL, payload);
    
    if (!req.body.skipFirestore && payload.depositAmount) {
      const userRef = db.collection('users').doc(userEmail);
      await userRef.set({ balance: admin.firestore.FieldValue.increment(-parseFloat(payload.depositAmount)) }, { merge: true });
    }
    
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Error logging deposit:', error);
    res.status(500).send('Internal Server Error: Failed to log deposit');
  }
});

// Endpoint: Log an Ad-hoc Project Cash Expense
app.post('/api/project/log-expense', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const payload = {
      ...req.body,
      action: "logExpense",
      userEmail: userEmail
    };

    const response = await axios.post(APPS_SCRIPT_URL, payload);
    
    if (!req.body.skipFirestore && payload.amount) {
      // Look up the user's display name from Firestore users collection
      let displayName = userEmail; // fallback to email
      try {
        const userDoc = await db.collection('users').doc(userEmail).get();
        if (userDoc.exists && userDoc.data().name) {
          displayName = userDoc.data().name;
        }
      } catch (_) {}

      const itemRef = db.collection('projects').doc(payload.projectName).collection('items').doc(`EXPENSE-${Date.now()}`);
      await itemRef.set({
          name: `EXPENSE: ${payload.expenseName}`,
          qty: 1,
          estPriceRange: "Cash Expense",
          estPriceFrom: 0,
          estPriceTo: 0,
          referenceImageBase64: '',
          status: 'Bought',
          assignedTo: displayName, // Store display name, not email
          piecePrice: parseFloat(payload.amount),
          totalPrice: parseFloat(payload.amount)
      });
    }
    
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Error logging expense:', error);
    res.status(500).send('Internal Server Error: Failed to log expense');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint: Add a vendor (Change 2c)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/vendor/add', verifyToken, async (req, res) => {
  try {
    const { name, place, phone, projectName } = req.body;
    if (!name) return res.status(400).send('Vendor name is required');

    // Save to Firestore with projectName
    await db.collection('vendors').add({
      name,
      place: place || '',
      phone: phone || '',
      projectName: projectName || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Notify GAS to add to "vendor list" sheet
    try {
      await axios.post(APPS_SCRIPT_URL, {
        action: 'addVendor',
        vendorName: name,
        vendorPlace: place || '',
        vendorPhone: phone || '',
        projectName: projectName || ''
      });
    } catch (_) {}

    res.status(200).json({ status: 'success', message: 'Vendor added' });
  } catch (error) {
    console.error('Error adding vendor:', error);
    res.status(500).json({ error: 'Failed to add vendor' });
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

// ── DASHBOARD KEY-PROTECTED ENDPOINTS (for dashboard.html, no Firebase login needed) ──

const DASHBOARD_KEY = 'Sirkil.com2013';

function verifyDashboardKey(req, res, next) {
  if (req.headers['x-dashboard-key'] === DASHBOARD_KEY) return next();
  return res.status(403).send('Forbidden');
}

// Setup / update a user's Firestore doc (name, role, scriptUrl)
app.post('/api/users/setup', verifyDashboardKey, async (req, res) => {
  const { email, name, role, scriptUrl } = req.body;
  if (!email) return res.status(400).send('Missing email');
  try {
    const update = { role: role || 'User' };
    if (name !== undefined) update.name = name;
    if (name !== undefined) update.email = email;
    if (scriptUrl !== undefined) update.scriptUrl = scriptUrl;
    await db.collection('users').doc(email).set(update, { merge: true });
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error setting up user:', error);
    res.status(500).send(error.message);
  }
});

// Change a user's Firebase Auth password
app.post('/api/users/change-password', verifyDashboardKey, async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).send('Missing fields');
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(userRecord.uid, { password: newPassword });
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).send(error.message);
  }
});

// --- USER MANAGEMENT ENDPOINTS ---

app.post('/api/users/create', verifyToken, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).send('Missing fields');
  try {
    const callerEmail = req.user.email;
    const authorizedAdmins = ["ahmed.tanany@sirkil.com", "admin@sirkil.com", "operations@sirkil.com", "omar@sirkil.com", "amr@sirkil.com", "farah.ashraf@sirkil.com"];
    let isAdmin = authorizedAdmins.includes(callerEmail);
    if (!isAdmin) {
       const docSnap = await db.collection('users').doc(callerEmail).get();
       if (docSnap.exists && docSnap.data().role === 'Admin') isAdmin = true;
    }
    if (!isAdmin) return res.status(403).send('Forbidden: Admins only');

    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: name,
    });

    await db.collection('users').doc(email).set({
      name,
      email,
      role: 'User',
      balance: 0,
      scriptUrl: '',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ status: 'success', uid: userRecord.uid });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).send(error.message);
  }
});

app.post('/api/users/update-password', verifyToken, async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).send('Missing fields');
  try {
    const callerEmail = req.user.email;
    const authorizedAdmins = ["ahmed.tanany@sirkil.com", "admin@sirkil.com", "operations@sirkil.com", "omar@sirkil.com", "amr@sirkil.com", "farah.ashraf@sirkil.com"];
    let isAdmin = authorizedAdmins.includes(callerEmail);
    if (!isAdmin) {
       const docSnap = await db.collection('users').doc(callerEmail).get();
       if (docSnap.exists && docSnap.data().role === 'Admin') isAdmin = true;
    }
    if (!isAdmin) return res.status(403).send('Forbidden: Admins only');

    const userRecord = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(userRecord.uid, { password: newPassword });
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).send(error.message);
  }
});

app.post('/api/users/update-profile', verifyToken, async (req, res) => {
  const { email, role, scriptUrl } = req.body;
  if (!email) return res.status(400).send('Missing email');
  try {
    const callerEmail = req.user.email;
    const authorizedAdmins = ["ahmed.tanany@sirkil.com", "admin@sirkil.com", "operations@sirkil.com", "omar@sirkil.com", "amr@sirkil.com", "farah.ashraf@sirkil.com"];
    let isAdmin = authorizedAdmins.includes(callerEmail);
    if (!isAdmin) {
       const docSnap = await db.collection('users').doc(callerEmail).get();
       if (docSnap.exists && docSnap.data().role === 'Admin') isAdmin = true;
    }
    if (!isAdmin) return res.status(403).send('Forbidden: Admins only');

    await db.collection('users').doc(email).set({
      role: role || 'User',
      scriptUrl: scriptUrl || ''
    }, { merge: true });

    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).send(error.message);
  }
});

// Fallback route for Flutter Web App (Single Page Application routing support)
app.get(/^\/app.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/app', 'index.html'));
});

// Email Transporter Configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD
  }
});

// Endpoint to send an email
app.post('/api/send-email', async (req, res) => {
  const { to, cc, subject, htmlBody } = req.body;

  if (!to || !subject || !htmlBody) {
    return res.status(400).json({ error: 'Missing to, subject, or htmlBody' });
  }

  try {
    const info = await transporter.sendMail({
      from: `"Sirkil Operation" <${process.env.SMTP_EMAIL}>`,
      to,
      cc,
      subject,
      html: htmlBody
    });
    console.log('Email sent:', info.messageId);
    res.status(200).json({ status: 'success', messageId: info.messageId });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Node.js middleware running on port ${PORT}`);
});