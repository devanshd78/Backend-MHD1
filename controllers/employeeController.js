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

function isValidUpi(upi) {
  return /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(upi);
}

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

  if (!name || !amount || !employeeId) {
    return res.status(400).json({ error: 'name, amount, and employeeId are required' });
  }

  let upiId = manualUpiId?.trim();

  // Attempt to decode QR if no manual UPI
  if (!upiId && req.file) {
    try {
      const img = await Jimp.read(req.file.buffer);
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
        } catch (err) {
          if (!done) {
            done = true;
            reject(err);
          }
        }

        setTimeout(() => {
          if (!done) {
            done = true;
            reject(new Error('QR decode timed out'));
          }
        }, 5000);
      });

      upiId = upiString.startsWith('upi://') ? parse(upiString.split('?')[1]).pa : upiString.trim();

    } catch (err) {
      console.error('QR decode error:', err.message);
      return res.status(400).json({ error: 'Invalid or unreadable QR code' });
    }
  }

  if (!upiId) {
    return res.status(400).json({ error: 'UPI ID is required via QR or manually' });
  }

  if (!isValidUpi(upiId)) {
    return res.status(400).json({ error: 'Invalid UPI ID format' });
  }

  const entry = new Entry({
    linkId,
    employeeId,
    name: name.trim(),
    upiId,
    amount,
    notes: notes?.trim() || ''
  });

  try {
    await entry.save();
    res.json({ message: 'Entry submitted successfully', upiId });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'This UPI ID has already been used for this link' });
    }
    throw err;
  }
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
  const { linkId, employeeId, entryId } = req.params;
  let { name, amount, upiId: rawUpi, notes: rawNotes } = req.body;

  // 1) Basic validation
  if (!linkId || !employeeId || !entryId) {
    return res.status(400).json({ error: 'linkId, employeeId and entryId are required' });
  }
  if (!rawUpi || !name || amount == null) {
    return res.status(400).json({ error: 'name, amount, and upiId are required' });
  }

  const nameTrimmed = name.trim();
  const notes = rawNotes?.trim() || '';
  const upiId = rawUpi.trim();

  // 2) Validate UPI format
  if (!isValidUpi(upiId)) {
    return res.status(400).json({ error: 'Invalid UPI ID format' });
  }

  // 3) Load exactly the entry we want to update
  const entry = await Entry.findOne({ _id: entryId, linkId, employeeId });
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found for this link/employee' });
  }

  // 4) If UPI changed, make sure no one else on this link is already using it
  if (entry.upiId !== upiId) {
    const conflict = await Entry.findOne({
      linkId,
      upiId,
      _id: { $ne: entryId }
    });
    if (conflict) {
      return res.status(400).json({ error: 'This UPI ID has already been used for this link' });
    }
  }

  // 5) Apply updates
  entry.name   = nameTrimmed;
  entry.amount = amount;
  entry.upiId  = upiId;
  entry.notes  = notes;

  // 6) Save & catch any leftover duplicate-key errors
  try {
    await entry.save();
    res.json({ message: 'Entry updated successfully', entry });
  } catch (err) {
    if (err.code === 11000) {
      // In case the index still trips for some reason
      return res.status(400).json({ error: 'This UPI ID has already been used for this link' });
    }
    throw err;
  }
});
