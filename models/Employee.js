// models/Employee.js
const mongoose = require('mongoose')
const bcrypt   = require('bcrypt')
const { v4: uuidv4 } = require('uuid')

const employeeSchema = new mongoose.Schema({
  email:      { type: String, required: true, unique: true },
  password:   { type: String, required: true },
  employeeId: { type: String, required: true, unique: true, default: uuidv4 },
  name:       { type: String, required: true },
  createdAt:  { type: Date,   default: Date.now }
})

// Hash password before saving (only if it's new or changed)
employeeSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  const salt = await bcrypt.genSalt(12)
  this.password = await bcrypt.hash(this.password, salt)
  next()
})

module.exports = mongoose.model('Employee', employeeSchema)
