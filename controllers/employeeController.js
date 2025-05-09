// controllers/employee.js
const { v4: uuidv4 } = require('uuid')
const Employee = require('../models/Employee')
const Link = require('../models/Link')
const Entry = require('../models/Entry')
const bcrypt = require('bcrypt')
const { PNG } = require('pngjs');

// <-- fixed: pull Jimp out of the named exports in v0.16+
const { Jimp } = require('jimp')
const QrCode = require('qrcode-reader')
const { parse } = require('querystring')

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

exports.register = async (req, res) => {
  const { email, password, name } = req.body
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Name, email and password required' })
  }

  // Check for existing email
  const existingUser = await Employee.findOne({ email })
  if (existingUser) {
    return res.status(409).json({ error: 'Email already in use' })
  }

  const employeeId = uuidv4()

  const user = new Employee({
    email,
    password,
    name,
    employeeId,
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


exports.submitEntry = asyncHandler(async (req, res) => {
  const { name, amount, employeeId, upiId: manualUpiId, notes } = req.body;
  const { linkId } = req.params;

  // 1) Required fields
  if (!name || !amount || !employeeId) {
    return res.status(400).json({ error: 'name, amount, and employeeId are all required' });
  }

  let upiId = manualUpiId?.trim();

  // 2) If no manual UPI, decode QR from uploaded image
  if (!upiId && req.file) {
    try {
      const img = await Jimp.read(req.file.buffer);

      // Decode QR with timeout to avoid hanging
      const upiString = await new Promise((resolve, reject) => {
        const qr = new QrCode();
        let done = false;
        
        qr.callback = (err, value) => {
          if (done) return;
          done = true;
          if (err || !value) return reject(new Error('Failed to decode QR'));
          resolve(value.result);
        };

        try {
          qr.decode(img.bitmap);
        } catch (decodeErr) {
          if (!done) {
            done = true;
            return reject(decodeErr);
          }
        }

        // timeout fallback
        setTimeout(() => {
          if (!done) {
            done = true;
            reject(new Error('QR decode timed out'));
          }
        }, 5000);
      });

      // Extract UPI ID from URI or raw string
      if (upiString.startsWith('upi://')) {
        const [, query] = upiString.split('?');
        const params = parse(query);
        upiId = params.pa;
      } else {
        upiId = upiString.trim();
      }

    } catch (err) {
      console.error('QR decode error:', err);
      return res.status(400).json({ error: 'Invalid or unreadable QR code' });
    }
  }

  // 3) Require UPI one way or another
  if (!upiId) {
    return res.status(400).json({ error: 'UPI ID is required via QR or manually' });
  }

  // 4) Manual UPI format check
  if (manualUpiId && !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(manualUpiId)) {
    return res.status(400).json({ error: 'Invalid UPI ID format' });
  }

  // 5) Prevent duplicates
  const exists = await Entry.findOne({ linkId, upiId });
  if (exists) {
    return res.status(400).json({ error: 'This UPI ID has already been used for this link' });
  }

  // 6) Save entry
  const entry = new Entry({
    linkId,
    employeeId,
    name: name.trim(),
    upiId,
    amount,
    notes: notes?.trim() || '',
  });

  await entry.save();

  res.json({ message: 'Entry submitted successfully', upiId });
});

exports.getEntriesByLink = asyncHandler(async (req, res) => {
  const {
    employeeId,
    linkId,
    page = 1,
    limit = 10,
  } = req.body;

  if (!employeeId || !linkId) {
    return badRequest(res, 'Both employeeId and linkId are required');
  }

  const filter = { employeeId, linkId };

  /* ---------------------------------------------------------- *
   * 1) gather counts + latestLink + page of rows in parallel   *
   * ---------------------------------------------------------- */
  const [total, latestLink, entries] = await Promise.all([
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
    page: Number(page),
    pages: Math.ceil(total / limit),
  });
});

exports.getEntryByEmployee = asyncHandler(async (req, res) => {
  const { linkId, employeeId } = req.params;

  if (!linkId || !employeeId) {
    return res.status(400).json({ error: 'linkId and employeeId are required' });
  }

  const entry = await Entry.findOne({ linkId, employeeId });

  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }

  res.json({ entry });
});


exports.updateEntryByEmployee = asyncHandler(async (req, res) => {
  const { linkId, employeeId } = req.params;
  const { name, amount, upiId, notes } = req.body;

  if (!linkId || !employeeId) {
    return res.status(400).json({ error: 'linkId and employeeId are required' });
  }

  if (!name || !amount || !upiId) {
    return res.status(400).json({ error: 'name, amount, and upiId are required' });
  }

  if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(upiId)) {
    return res.status(400).json({ error: 'Invalid UPI ID format' });
  }

  const duplicate = await Entry.findOne({
    linkId,
    upiId,
    employeeId: { $ne: employeeId }
  });

  if (duplicate) {
    return res.status(400).json({ error: 'This UPI ID has already been used for this link' });
  }

  const entry = await Entry.findOneAndUpdate(
    { linkId, employeeId },
    {
      name: name.trim(),
      upiId: upiId.trim(),
      amount,
      notes: notes?.trim() || ''
    },
    { new: true }
  );

  if (!entry) {
    return res.status(404).json({ error: 'Entry not found for this link and employee' });
  }

  res.json({ message: 'Entry updated successfully', entry });
});
