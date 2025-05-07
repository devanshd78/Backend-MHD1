// scripts/seedAdmin.js
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const Admin    = require('../models/Admin');

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);

  const email    = 'admin@mhd.com';
  const password = 'Admin@1234';

  let admin = await Admin.findOne({ email });
  if (!admin) {
    const hash = await bcrypt.hash(password, 12);
    const newAdmin = new Admin({
      adminId: uuidv4(),   // explicitly generate here
      email,
      password: hash
    });
    await newAdmin.save();
    console.log('✅ Seeded admin:', email, 'with adminId', newAdmin.adminId);
  } else {
    console.log('⚠️  Admin already exists:', email, '– adminId:', admin.adminId);
  }

  await mongoose.disconnect();
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
