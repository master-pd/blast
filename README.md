# ব্লাস্টার API

WhatsApp অ্যাকাউন্ট ভাড়া ও মেসেজ ব্লাস্টিং সিস্টেম

## বৈশিষ্ট্যসমূহ

- ✅ মাল্টি-অ্যাকাউন্ট WhatsApp সংযোগ
- ✅ QR কোড অথেনটিকেশন
- ✅ অ্যাকাউন্ট ভাড়া দেওয়ার সিস্টেম
- ✅ এডমিন অ্যাপ্রুভাল সিস্টেম
- ✅ বাল্ক মেসেজ ব্লাস্টিং
- ✅ JWT অথেনটিকেশন
- ✅ Firebase Firestore ডেটাবেস
- ✅ সেশন ম্যানেজমেন্ট
- ✅ অটো-রিকানেক্ট

## API এন্ডপয়েন্ট

### অথেনটিকেশন
- `POST /api/auth/register` - নিবন্ধন
- `POST /api/auth/login` - লগইন
- `GET /api/auth/profile` - প্রোফাইল

### অ্যাকাউন্ট (সাধারণ ইউজার)
- `POST /api/accounts/add` - নতুন অ্যাকাউন্ট যোগ
- `GET /api/accounts/my` - আমার অ্যাকাউন্টসমূহ
- `GET /api/accounts/qr/:accountId` - QR কোড
- `POST /api/accounts/offer/:accountId` - ভাড়া দেওয়ার প্রস্তাব
- `DELETE /api/accounts/:accountId` - অ্যাকাউন্ট মুছে ফেলা

### অ্যাকাউন্ট (এডমিন)
- `GET /api/accounts/pending` - অপেক্ষমাণ অ্যাকাউন্ট
- `GET /api/accounts/available` - উপলব্ধ অ্যাকাউন্ট
- `GET /api/accounts/rented` - ভাড়া করা অ্যাকাউন্ট
- `POST /api/accounts/approve/:accountId` - অ্যাপ্রুভ
- `POST /api/accounts/rent/:accountId` - ভাড়া নেওয়া
- `POST /api/accounts/return/:accountId` - ফেরত দেওয়া

### মেসেজ (এডমিন)
- `POST /api/messages/blast` - বাল্ক মেসেজ
- `POST /api/messages/send` - সিঙ্গেল মেসেজ
- `GET /api/messages/history` - ইতিহাস
- `GET /api/messages/status/:messageId` - স্ট্যাটাস

## ডিপ্লয়মেন্ট

### লোকাল রান
```bash
git clone https://github.com/master-pd/blaster.git
cd blaster-backend
npm install
npm run dev

```
This tools in development 
