// models/User.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const userSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
    default: uuidv4
  },
  name: {
    type: String,
    required: true
  },
  phone: {
    type: Number,
    required: true,
    unique: true,
    validate: {
      validator: Number.isInteger,
      message: 'Phone number must be an integer.'
    }
  },
  email: {
    type: String,
    required: true,
    unique: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please fill a valid email address']
  },
  password: {
    type: String,
    required: true
  },
  worksUnder: {
    type: String,
    required: true,
    ref: 'Employee'
  },
  upiId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    match: [/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/, 'Invalid UPI format']
  }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
