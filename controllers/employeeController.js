// controllers/employee.js
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const Employee = require('../models/Employee');
const Link = require('../models/Link');

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg) => res.status(404).json({ error: msg });

/* ------------------------------------------------------------------ */
/*  AUTH – register / login                                           */
/* ------------------------------------------------------------------ */
exports.register = asyncHandler(async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return badRequest(res, 'Name, email and password required');

  if (await Employee.exists({ email }))
    return res.status(409).json({ error: 'Email already in use' });

  const employee = await Employee.create({
    employeeId: uuidv4(),
    email,
    password,                 // hash middleware in schema (if set) will run
    name
  });

  res.json({
    message: 'Registration successful – pending admin approval',
    employeeId: employee.employeeId
  });
});

exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const employee = await Employee.findOne({ email }).select('+password');
  if (!employee || !(await bcrypt.compare(password, employee.password)))
    return res.status(401).json({ error: 'Invalid credentials' });

  if (employee.isApproved === 0)
    return res.status(403).json({ error: 'Account not approved yet' });

  res.json({
    message: 'Login successful',
    userId: employee._id,
    employeeId: employee.employeeId,
    name: employee.name
  });
});

/* ------------------------------------------------------------------ */
/*  QUICK STATS / BALANCE                                             */
/* ------------------------------------------------------------------ */
exports.getBalance = asyncHandler(async (req, res) => {
  const { employeeId } = req.query;
  if (!employeeId) return badRequest(res, 'Employee ID is required');

  const employee = await Employee.findOne({ employeeId });
  if (!employee) return notFound(res, 'Employee not found');

  res.json({ balance: employee.balance });
});

/* ------------------------------------------------------------------ */
/*  LINK LIST (for employee panel, no entries here)                   */
/* ------------------------------------------------------------------ */
exports.listLinks = asyncHandler(async (_req, res) => {
  const links = await Link.find().lean();
  if (links.length === 0) return res.json([]);

  const latestId = links.reduce((a, b) =>
    a.createdAt > b.createdAt ? a : b
  )._id.toString();

  const annotated = links.map(l => ({ ...l, isLatest: l._id.toString() === latestId }));
  res.json(annotated.reverse());
});

exports.getLink = asyncHandler(async (req, res) => {
  const link = await Link.findById(req.params.linkId);
  if (!link) return notFound(res, 'Link not found');
  res.json(link);
});
