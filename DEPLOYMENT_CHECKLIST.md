# 🚀 Deployment Checklist - LMS v2.0

## ✅ Pre-Deployment Verification

### Files to Upload:
- [x] server.js (v2.0 - Full Feature Update)
- [x] package.json (with node-cron dependency)
- [x] public/admin-full.html (with email checkboxes & monthly assessment)
- [x] public/parent.html (with report cards tab)
- [x] public/index.html
- [x] All other files in /public folder

### Environment Variables (.env):
```
DATABASE_URL=your_postgresql_url
BREVO_API_KEY=your_brevo_api_key
EMAIL_USER=your_email@domain.com
ADMIN_EMAIL=admin@yourschool.com
ADMIN_PASSWORD=your_secure_password
```

## 🔧 Deployment Steps

### Step 1: Upload Files
1. Delete old deployment files (if possible)
2. Upload ALL files from your local folder
3. Ensure public/ folder structure is preserved

### Step 2: Verify Upload
Check these files exist on server:
- server.js
- package.json
- public/admin-full.html
- public/parent.html
- public/index.html

### Step 3: Redeploy
1. Trigger manual redeploy
2. Watch build logs for errors
3. Wait for "Starting Advanced LMS Server v2.0" message
4. Check for "Database tables already exist" or "Creating new database tables"

### Step 4: Clear Cache
On your browser:
1. Press Ctrl + Shift + Delete
2. Clear cached images and files
3. Close browser completely
4. Reopen and visit site
5. Hard refresh: Ctrl + F5

## 🎯 What You Should See After Deployment

### Admin Dashboard:
✅ Header: "🎓 Fluent Feathers Academy By Aaliya"
✅ Tagline: "Empowering Young Minds Through Language & Communication"
✅ Tab: "📊 Monthly Assessment" (not "Certificates")

### Add Student Form:
✅ Field: "Date of Birth (Optional)"
✅ Checkbox: "Send Welcome Email"
✅ 15 timezone options
✅ 12 currency options

### Schedule Forms:
✅ Private Schedule - Checkbox: "Send Schedule Confirmation Email"
✅ Group Schedule - Checkbox: "Send Schedule Confirmation Email"

### Create Event Form:
✅ Checkbox: "Send Event Notification Email"

### Monthly Assessment Tab:
✅ 10 skill checkboxes (Speaking, Confidence, Grammar, etc.)
✅ Certificate dropdown with 11 titles + Custom option
✅ 3 text areas (Performance, Improvement, Comments)
✅ Checkbox: "Send Report Card & Certificate via Email"

### Parent Portal:
✅ Tab: "📊 Report Cards" (not "Certificates")
✅ Tab: "📢 News"

## ❌ Troubleshooting

### If you still see old version:

**Problem 1: Browser Cache**
- Clear browser cache (Ctrl + Shift + Delete)
- Try incognito/private mode
- Try different browser

**Problem 2: Server Cache**
- Some platforms cache static files
- Look for "Clear build cache" option
- Redeploy with cache clearing enabled

**Problem 3: Files Not Uploaded**
- Verify file sizes match:
  - server.js should be ~80-85 KB
  - admin-full.html should be ~90-95 KB
  - parent.html should be ~40-45 KB
- Check file timestamps are recent

**Problem 4: Old Build**
- Check deployment logs
- Ensure build completed successfully
- Look for errors during npm install

## 🔍 Quick Verification Commands

If you have terminal/SSH access:

```bash
# Check server version
grep "v2.0" server.js

# Check for email checkboxes
grep "sendWelcomeEmail" public/admin-full.html

# Check for monthly assessment
grep "monthlyAssessmentTab" public/admin-full.html

# Check node-cron dependency
grep "node-cron" package.json
```

## 📞 If Issues Persist

1. **Check Console Errors:**
   - Press F12 in browser
   - Go to Console tab
   - Look for JavaScript errors
   - Screenshot and share

2. **Check Network Tab:**
   - Press F12 → Network tab
   - Refresh page
   - Check if admin-full.html is loading
   - Verify file size matches local file

3. **Verify Database:**
   - Tables should auto-create on first run
   - Check deployment logs for database connection
   - Look for "Database tables already exist" message

## ✅ Success Indicators

You'll know deployment worked when:
- ✅ Console shows: "Starting Advanced LMS Server v2.0"
- ✅ Admin panel shows "Monthly Assessment" tab
- ✅ All forms have email checkboxes
- ✅ Parent portal shows "Report Cards" tab
- ✅ Header shows full academy name + tagline

---

**Version:** 2.0
**Last Updated:** January 2026
**Total Features:** 74 API endpoints, 5 email checkboxes, Monthly assessments
