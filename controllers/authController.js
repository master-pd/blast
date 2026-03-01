const admin = require('../config/firebase');

// ফোন নম্বর দিয়ে OTP পাঠানো
exports.sendOTP = async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Phone number is required' 
      });
    }

    // ফোন নম্বর ফরম্যাট চেক করা (+8801XXXXXXXXX)
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format. Use international format (e.g., +8801XXXXXXXXX)'
      });
    }

    // ইউজার আগে থেকে আছে কিনা চেক করা
    let userExists = false;
    let userData = null;
    
    try {
      const user = await admin.auth().getUserByPhoneNumber(phoneNumber);
      userExists = true;
      userData = {
        uid: user.uid,
        phoneNumber: user.phoneNumber,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL
      };
    } catch (error) {
      // ইউজার না থাকলে সাইলেন্টলি ইগনোর করব
      userExists = false;
    }

    // নোট: Firebase স্বয়ংক্রিয়ভাবে OTP পাঠায় ক্লায়েন্ট সাইডে
    // আমাদের শুধু রেসপন্স দিতে হবে

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully',
      data: {
        phoneNumber,
        isExistingUser: userExists,
        userData: userData || null
      }
    });

  } catch (error) {
    console.error('Send OTP Error:', error);
    
    let errorMessage = 'Failed to send OTP';
    if (error.code === 'auth/invalid-phone-number') {
      errorMessage = 'Invalid phone number';
    } else if (error.code === 'auth/too-many-requests') {
      errorMessage = 'Too many requests. Please try again later';
    }

    res.status(500).json({ 
      success: false, 
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// OTP ভেরিফাই করা
exports.verifyOTP = async (req, res) => {
  try {
    const { idToken, phoneNumber } = req.body;

    if (!idToken) {
      return res.status(400).json({ 
        success: false, 
        message: 'ID token is required' 
      });
    }

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    // Firebase ID Token ভেরিফাই করা
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
      if (error.code === 'auth/id-token-expired') {
        return res.status(401).json({ 
          success: false, 
          message: 'Token expired. Please request new OTP' 
        });
      }
      if (error.code === 'auth/argument-error') {
        return res.status(401).json({ 
          success: false, 
          message: 'Invalid token' 
        });
      }
      throw error;
    }

    // টোকেন থেকে ফোন নম্বর চেক করা
    if (decodedToken.phone_number !== phoneNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Phone number mismatch' 
      });
    }

    // ইউজার ডেটা ফেচ করা
    const user = await admin.auth().getUser(decodedToken.uid);

    // কাস্টম টোকেন তৈরি করা (ঐচ্ছিক)
    const customToken = await admin.auth().createCustomToken(decodedToken.uid);

    // ইউজার নতুন কিনা চেক করা
    const isNewUser = user.metadata.creationTime === user.metadata.lastSignInTime;

    res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      data: {
        uid: user.uid,
        phoneNumber: user.phoneNumber,
        email: user.email || null,
        displayName: user.displayName || null,
        photoURL: user.photoURL || null,
        customToken: customToken,
        isNewUser: isNewUser,
        createdAt: user.metadata.creationTime,
        lastLoginAt: user.metadata.lastSignInTime
      }
    });

  } catch (error) {
    console.error('Verify OTP Error:', error);
    
    let errorMessage = 'Failed to verify OTP';
    if (error.code === 'auth/user-not-found') {
      errorMessage = 'User not found';
    }

    res.status(500).json({ 
      success: false, 
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ইউজার প্রোফাইল আপডেট করা
exports.updateUserProfile = async (req, res) => {
  try {
    const { uid, displayName, email, photoURL } = req.body;

    if (!uid) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    const updateData = {};
    if (displayName) updateData.displayName = displayName;
    if (email) updateData.email = email;
    if (photoURL) updateData.photoURL = photoURL;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one field to update is required'
      });
    }

    const updatedUser = await admin.auth().updateUser(uid, updateData);

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        uid: updatedUser.uid,
        displayName: updatedUser.displayName,
        email: updatedUser.email,
        phoneNumber: updatedUser.phoneNumber,
        photoURL: updatedUser.photoURL
      }
    });

  } catch (error) {
    console.error('Update Profile Error:', error);
    
    let errorMessage = 'Failed to update profile';
    if (error.code === 'auth/user-not-found') {
      errorMessage = 'User not found';
    } else if (error.code === 'auth/email-already-exists') {
      errorMessage = 'Email already exists';
    }

    res.status(500).json({ 
      success: false, 
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ইউজার ডেটা পাওয়া
exports.getUserData = async (req, res) => {
  try {
    const { uid } = req.params;

    if (!uid) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    const user = await admin.auth().getUser(uid);

    res.status(200).json({
      success: true,
      data: {
        uid: user.uid,
        phoneNumber: user.phoneNumber,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        creationTime: user.metadata.creationTime,
        lastSignInTime: user.metadata.lastSignInTime,
        disabled: user.disabled,
        emailVerified: user.emailVerified
      }
    });

  } catch (error) {
    console.error('Get User Data Error:', error);
    
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(500).json({ 
      success: false, 
      message: 'Failed to get user data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ইউজার ডিলিট করা
exports.deleteUser = async (req, res) => {
  try {
    const { uid } = req.params;

    if (!uid) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    await admin.auth().deleteUser(uid);

    res.status(200).json({
      success: true,
      message: 'User deleted successfully'
    });

  } catch (error) {
    console.error('Delete User Error:', error);
    
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete user',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};
