// controllers/employee.js
const { v4: uuidv4 } = require('uuid')
const Employee = require('../models/Employee')
const Link = require('../models/Link')
const Entry = require('../models/Entry')
const bcrypt = require('bcrypt')

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

exports.register = async (req, res) => {
  const { email, password, name } = req.body
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Name, email and password required' })
  }

  // generate and store a unique employeeId
  const employeeId = uuidv4()

  const user = new Employee({
    email,
    password,
    name,
    employeeId,          // ← new field
  })

  await user.save()

  res.json({
    message: 'Registration successful',
    employeeId: user.employeeId
  })
}

exports.login = async (req, res) => {
  const { email, password } = req.body

  // 1) Find user by email
  const user = await Employee.findOne({ email })
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  // 2) Compare provided password to the hash
  const isMatch = await bcrypt.compare(password, user.password)
  if (!isMatch) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  // 3) Success—return the employeeId (and any other info)
  res.json({
    message: 'Login successful',
    userId: user._id,
    employeeId: user.employeeId,
    name: user.name
  })
}

// controllers/adminController.js
exports.listLinks = async (req, res) => {
  // 1) Fetch all links
  const links = await Link.find().lean()

  if (links.length === 0) {
    return res.json([])
  }

  const latestLink = links.reduce((prev, curr) =>
    new Date(prev.createdAt) > new Date(curr.createdAt) ? prev : curr
  )

  const latestId = latestLink._id.toString()

  const annotated = links.map(link => ({
    ...link,
    isLatest: link._id.toString() === latestId
  }))

  return res.json(annotated.reverse())
}


exports.getLink = async (req, res) => {
  const link = await Link.findById(req.params.linkId)
  if (!link) return res.status(404).json({ error: 'Link not found' })
  res.json(link)
}

// controllers/employee.js
exports.submitEntry = async (req, res) => {
  const { name, upiId, amount, employeeId } = req.body;
  const { linkId } = req.params;

  // Simple validation
  if (!name || !upiId || !amount || !employeeId) {
    return res
      .status(400)
      .json({ error: 'name, upiId, amount and employeeId are all required' });
  }

  // Build entry with only those four fields + linkId
  const entry = new Entry({
    linkId,
    name,
    upiId,
    amount,
    employeeId,
  });

  await entry.save();

  res.json({ message: 'Entry submitted successfully' });
};

exports.getEntriesByLink = asyncHandler(async (req, res) => {
  const {
    employeeId,
    linkId,
    page  = 1,
    limit = 10,
  } = req.body;

  if (!employeeId || !linkId) {
    return badRequest(res, 'Both employeeId and linkId are required');
  }

  const filter = { employeeId, linkId };

  /* ---------------------------------------------------------- *
   * 1) gather counts + latestLink + page of rows in parallel   *
   * ---------------------------------------------------------- */
  const [ total, latestLink, entries ] = await Promise.all([
    Entry.countDocuments(filter),
    Link.findOne().sort({ createdAt: -1 }).select('_id').lean(),
    Entry.find(filter)
         .sort({ createdAt: -1 })
         .skip((page - 1) * limit)
         .limit(limit)
         .lean(),
  ]);

  /* grand total amount (across ALL pages) */
  const totalAmount = await Entry.aggregate([
    { $match: filter },
    { $group: { _id: null, sum: { $sum: '$amount' } } },
  ]).then(r => (r[0]?.sum ?? 0));

  /* ---------------------------------------------------------- */
  res.json({
    entries,                      // current page
    totalAmount,                  // sum across ALL entries
    isLatest: latestLink?._id.toString() === linkId,
    total,                        // total rows
    page:  Number(page),
    pages: Math.ceil(total / limit),
  });
});