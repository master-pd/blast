const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================
// ইমেইল ট্রান্সপোর্টার কনফিগারেশন
// =============================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// =============================================
// অপারেটর ডিটেক্টর ফাংশন
// =============================================
function getOperatorEmail(phoneNumber) {
  // নম্বর ক্লিন করুন
  let cleanNumber = phoneNumber.replace(/\D/g, '');
  
  // ফরম্যাট চেক
  if (cleanNumber.length === 11) {
    cleanNumber = '88' + cleanNumber;
  } else if (cleanNumber.length === 13 && cleanNumber.startsWith('88')) {
    // ঠিক আছে
  } else {
    throw new Error('Invalid phone number format. Use 11 or 13 digits');
  }

  // অপারেটর ডিটেক্ট
  if (cleanNumber.startsWith('88019')) {
    return { email: `${cleanNumber}@text.grameenphone.com`, operator: 'Grameenphone' };
  } else if (cleanNumber.startsWith('88018')) {
    return { email: `${cleanNumber}@robi.com.bd`, operator: 'Robi' };
  } else if (cleanNumber.startsWith('88017')) {
    return { email: `${cleanNumber}@sms.ebl.com`, operator: 'Banglalink' };
  } else if (cleanNumber.startsWith('88016')) {
    return { email: `${cleanNumber}@airtel.com.bd`, operator: 'Airtel' };
  } else if (cleanNumber.startsWith('88015')) {
    return { email: `${cleanNumber}@tmail.teletalk.com.bd`, operator: 'Teletalk' };
  } else {
    throw new Error('Unknown operator. Supported: 019, 018, 017, 016, 015');
  }
}

// =============================================
// ভ্যালিডেশন ফাংশন
// =============================================
function validateRequest(to, message) {
  const errors = [];
  
  if (!to) errors.push('Phone number is required');
  if (!message) errors.push('Message is required');
  if (message && message.length > 160) errors.push('Message too long (max 160 chars)');
  
  try {
    if (to) getOperatorEmail(to);
  } catch (e) {
    errors.push(e.message);
  }
  
  return errors;
}

// =============================================
// হেলথ চেক এন্ডপয়েন্ট
// =============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    email: process.env.EMAIL_USER ? '✅ Configured' : '❌ Not configured'
  });
});

// =============================================
// API হোম পেজ
// =============================================
app.get('/', (req, res) => {
  res.json({
    app: '📧 ইমেইল-টু-SMS API',
    version: '3.0.0',
    status: 'running',
    documentation: {
      get_method: {
        url: '/send?to=8801929671720&message=Hello',
        method: 'GET',
        example: 'curl "https://your-api.com/send?to=8801929671720&message=Hello"'
      },
      post_method: {
        url: '/send',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { to: '8801929671720', message: 'Hello' },
        example: 'curl -X POST -H "Content-Type: application/json" -d \'{"to":"8801929671720","message":"Hello"}\' https://your-api.com/send'
      },
      operators: '/operators - সাপোর্টেড অপারেটর লিস্ট'
    },
    endpoints: [
      { path: '/', method: 'GET', description: 'API তথ্য' },
      { path: '/health', method: 'GET', description: 'হেলথ চেক' },
      { path: '/send', method: 'GET', description: 'GET মেথডে SMS পাঠান' },
      { path: '/send', method: 'POST', description: 'POST মেথডে SMS পাঠান' },
      { path: '/operators', method: 'GET', description: 'সাপোর্টেড অপারেটর লিস্ট' }
    ]
  });
});

// =============================================
// GET Method - SMS পাঠান
// URL: /send?to=8801929671720&message=Hello
// =============================================
app.get('/send', async (req, res) => {
  const { to, message } = req.query;
  
  // ভ্যালিডেশন
  const errors = validateRequest(to, message);
  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      errors: errors,
      example: '/send?to=8801929671720&message=Hello'
    });
  }
  
  try {
    // অপারেটর ইমেইল বের করুন
    const { email, operator } = getOperatorEmail(to);
    
    // ইমেইল পাঠান
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: '', // খালি রাখুন
      text: message
    };
    
    const info = await transporter.sendMail(mailOptions);
    
    res.json({
      success: true,
      message: 'SMS sent successfully',
      to: to,
      operator: operator,
      messageId: info.messageId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// POST Method - SMS পাঠান
// URL: /send
// Body: { "to": "8801929671720", "message": "Hello" }
// =============================================
app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  
  // ভ্যালিডেশন
  const errors = validateRequest(to, message);
  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      errors: errors,
      example: { to: '8801929671720', message: 'Hello' }
    });
  }
  
  try {
    // অপারেটর ইমেইল বের করুন
    const { email, operator } = getOperatorEmail(to);
    
    // ইমেইল পাঠান
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: '', // খালি রাখুন
      text: message
    };
    
    const info = await transporter.sendMail(mailOptions);
    
    res.json({
      success: true,
      message: 'SMS sent successfully',
      to: to,
      operator: operator,
      messageId: info.messageId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// সাপোর্টেড অপারেটর লিস্ট
// =============================================
app.get('/operators', (req, res) => {
  res.json({
    success: true,
    operators: [
      { code: '019', name: 'Grameenphone', email: '88019XXXXXXXX@text.grameenphone.com' },
      { code: '018', name: 'Robi', email: '88018XXXXXXXX@robi.com.bd' },
      { code: '017', name: 'Banglalink', email: '88017XXXXXXXX@sms.ebl.com' },
      { code: '016', name: 'Airtel', email: '88016XXXXXXXX@airtel.com.bd' },
      { code: '015', name: 'Teletalk', email: '88015XXXXXXXX@tmail.teletalk.com.bd' }
    ],
    format: '8801XXXXXXXXX (13 digits) or 01XXXXXXXXX (11 digits)',
    note: 'Max message length: 160 characters'
  });
});

// =============================================
// 404 হ্যান্ডলার
// =============================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /',
      'GET /health',
      'GET /send?to=number&message=text',
      'POST /send',
      'GET /operators'
    ]
  });
});

// =============================================
// সার্ভার চালু
// =============================================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║     📧 ইমেইল-টু-SMS API চালু হয়েছে                      ║
╚══════════════════════════════════════════════════════════╝

📡 লোকাল URL: http://localhost:${PORT}
🌍 লোকাল নেটওয়ার্ক: http://${require('os').networkInterfaces()['eth0']?.[0]?.address || '192.168.x.x'}:${PORT}

📧 ইমেইল: ${process.env.EMAIL_USER ? '✅ Configured' : '❌ Not configured'}

🔗 API ব্যবহার:

1️⃣ GET Method (সহজ):
   http://localhost:${PORT}/send?to=8801929671720&message=Hello

2️⃣ POST Method:
   curl -X POST http://localhost:${PORT}/send \\
     -H "Content-Type: application/json" \\
     -d '{"to": "8801929671720", "message": "Hello"}'

3️⃣ সাপোর্টেড অপারেটর দেখুন:
   http://localhost:${PORT}/operators

4️⃣ হেলথ চেক:
   http://localhost:${PORT}/health

⚠️ মনে রাখবেন:
   • নম্বর: 8801929671720 (13 digits) বা 01929671720 (11 digits)
   • মেসেজ: সর্বোচ্চ 160 ক্যারেক্টার
   • সাবজেক্ট খালি রাখতে হবে
`);
});
