
// ============================================================================
// 0. Global Safe Error Handlers (Non-Blocking Logging)
// ============================================================================
window.addEventListener('error', function(e) {
    if (e.message && e.message.includes('ResizeObserver')) return;
    console.warn('[Application Error]:', e.message, 'at line:', e.lineno);
});

window.addEventListener('unhandledrejection', function(e) {
    console.warn('[Unhandled Promise Rejection]:', e.reason ? (e.reason.message || e.reason) : 'Unknown');
});

// ============================================================================
// 1. Security Utilities
// ============================================================================
window.escapeHTML = function(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g, function(tag) {
        const charsToReplace = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
        return charsToReplace[tag] || tag;
    });
};

// ============================================================================
// 2. Safe Database Initialization (No Duplicate Const SyntaxError)
// ============================================================================
if (typeof window.localAppDb === 'undefined') {
    window.localAppDb = (typeof Dexie !== 'undefined') ? new Dexie('Ra2idaLocalDB') : null;
    if (window.localAppDb && !window.localAppDb.isOpen()) {
        window.localAppDb.version(1).stores({
            classes: '++id, user_id, name, level, createdAt',
            students: '++id, class_id, user_id, name, massar_id, status, final_level, [class_id+user_id]'
        });
    }
}
const localAppDb = window.localAppDb;

// ============================================================================
// 3. Firebase Configuration & Memoized Cloud Auth
// ============================================================================
const firebaseConfig = window.FIREBASE_CONFIG || {
    apiKey: "AIzaSyDUR5OhENJjpQA24MaoQWw1WnOUTljRbis",
    authDomain: "ra2ida---naajed.firebaseapp.com",
    projectId: "ra2ida---naajed",
    storageBucket: "ra2ida---naajed.firebasestorage.app",
    messagingSenderId: "913670751939",
    appId: "1:913670751939:web:3c57e3da2fba35b36f0476",
    measurementId: "G-SFE7ETD9C5"
};

let cloudDb = null;
try {
    if (typeof firebase !== 'undefined' && !firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
        cloudDb = firebase.firestore();
    } else if (typeof firebase !== 'undefined' && firebase.apps.length) {
        cloudDb = firebase.firestore();
    }
} catch (e) {
    console.warn('Firebase initialization failed:', e);
}

function getLocalDeviceUid() {
    let uid = localStorage.getItem('ra2ida_user_uid');
    if (!uid || uid === 'default_user') {
        uid = 'device_' + (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '_' + Math.random().toString(36).substring(2)));
        localStorage.setItem('ra2ida_user_uid', uid);
    }
    return uid;
}
getLocalDeviceUid();

// Memoized Async Cloud Auth Promise
let cloudAuthPromise = null;
window.ensureCloudAuthReady = function() {
    if (cloudAuthPromise) return cloudAuthPromise;

    cloudAuthPromise = new Promise((resolve) => {
        if (typeof firebase === 'undefined' || !firebase.auth) {
            return resolve(getLocalDeviceUid());
        }

        const currentUser = firebase.auth().currentUser;
        if (currentUser && currentUser.uid) {
            localStorage.setItem('ra2ida_user_uid', currentUser.uid);
            return resolve(currentUser.uid);
        }

        const unsubscribe = firebase.auth().onAuthStateChanged(async (user) => {
            unsubscribe();
            if (user && user.uid) {
                const oldUid = localStorage.getItem('ra2ida_user_uid');
                localStorage.setItem('ra2ida_user_uid', user.uid);
                
                // Migrate local database records from temp device UID to true Firebase UID
                if (localAppDb && oldUid && oldUid !== user.uid) {
                    try {
                        await localAppDb.classes.where('user_id').equals(oldUid).modify({ user_id: user.uid });
                        await localAppDb.students.where('user_id').equals(oldUid).modify({ user_id: user.uid });
                    } catch (mErr) {
                        console.warn('Local DB migration warning:', mErr);
                    }
                }
                resolve(user.uid);
            } else {
                try {
                    const cred = await firebase.auth().signInAnonymously();
                    localStorage.setItem('ra2ida_user_uid', cred.user.uid);
                    resolve(cred.user.uid);
                } catch (authErr) {
                    console.warn('Anonymous auth failed, fallback to device UID:', authErr);
                    resolve(getLocalDeviceUid());
                }
            }
        });
    });

    return cloudAuthPromise;
};
window.ensureCloudAuthReady();

// ============================================================================
// 4. LocalDB Object Definition
// ============================================================================
window.LocalDB = {
    getUserId() {
        return localStorage.getItem('ra2ida_user_uid') || getLocalDeviceUid();
    },

    async getAsyncUserId() {
        return await window.ensureCloudAuthReady();
    },

    async getClasses() {
        if (!localAppDb) return [];
        const uid = await this.getAsyncUserId();
        const rawClasses = await localAppDb.classes.where('user_id').equals(uid).toArray();
        
        return await Promise.all(rawClasses.map(async (c) => {
            const classStudents = await localAppDb.students.where('class_id').equals(c.id).toArray();
            const evaluated = classStudents.filter(s => s.status && s.status !== 'pending').length;
            return {
                id: c.id,
                user_id: c.user_id,
                name: c.name,
                level: c.level,
                student_count: classStudents.length,
                evaluated_count: evaluated
            };
        }));
    },

    async getClass(classId) {
        if (!localAppDb) return null;
        return await localAppDb.classes.get(Number(classId));
    },

    async getClassStudents(classId) {
        if (!localAppDb) return [];
        const uid = await this.getAsyncUserId();
        const list = await localAppDb.students
            .where('class_id')
            .equals(Number(classId))
            .filter(s => s.user_id === uid)
            .toArray();
        return list.sort((a, b) => (a.order_number || a.id) - (b.order_number || b.id));
    },

    async saveClassWithStudents(className, level, studentsList) {
        if (!localAppDb) return { classId: null, count: 0 };
        const uid = await this.getAsyncUserId();
        
        let existing = await localAppDb.classes
            .where('user_id').equals(uid)
            .filter(c => c.name.trim().toLowerCase() === className.trim().toLowerCase())
            .first();

        let classId;
        if (existing) {
            classId = existing.id;
            await localAppDb.classes.update(classId, { level: level.trim(), updatedAt: new Date() });
            await localAppDb.students.where('class_id').equals(classId).delete();
        } else {
            classId = await localAppDb.classes.add({
                user_id: uid,
                name: className.trim(),
                level: level.trim(),
                createdAt: new Date()
            });
        }

        const normalizedStudents = studentsList.map((s, idx) => ({
            class_id: classId,
            user_id: uid,
            name: (s.name || s['اسم التلميذ'] || '').trim(),
            massar_id: (s.massar_id || s.massar || s['رقم مسار'] || s['Code Massar'] || 'غير متوفر').trim(),
            status: s.status || 'pending',
            final_level: s.final_level || null,
            stages: s.stages || { LTC: 'N/A', CTC: 'N/A', LP: 'N/A', CP: 'N/A', LTM: 'N/A', CTM: 'N/A' },
            order_number: s.order_number || (idx + 1)
        }));

        await localAppDb.students.bulkAdd(normalizedStudents);
        return { classId, count: normalizedStudents.length };
    },

    async updateStudent(studentId, updateData) {
        if (!localAppDb) return;
        return await localAppDb.students.update(Number(studentId), updateData);
    },

    async deleteStudent(studentId) {
        if (!localAppDb) return;
        return await localAppDb.students.delete(Number(studentId));
    },

    async renameClass(classId, newName) {
        if (!localAppDb) return;
        return await localAppDb.classes.update(Number(classId), {
            name: newName.trim(),
            updatedAt: new Date()
        });
    },

    async deleteClass(classId) {
        if (!localAppDb) return true;
        const cId = Number(classId);
        await localAppDb.students.where('class_id').equals(cId).delete();
        await localAppDb.classes.delete(cId);
        return true;
    },

    async deleteAllClasses() {
        if (!localAppDb) return true;
        const uid = await this.getAsyncUserId();
        const userClasses = await localAppDb.classes.where('user_id').equals(uid).toArray();
        const classIds = userClasses.map(c => c.id);
        
        await localAppDb.students.where('class_id').anyOf(classIds).delete();
        await localAppDb.classes.where('user_id').equals(uid).delete();
        return true;
    }
};

// ============================================================================
// 2. Client-Side Massar Excel Parser (SheetJS)
// ============================================================================
window.parseMassarWorkbook = async function(file) {
    return new Promise((resolve, reject) => {
        if (typeof XLSX === 'undefined') {
            return reject(new Error('مكتبة SheetJS غير محملة'));
        }
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                
                // Convert sheet to array of rows
                const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
                if (!rows || rows.length === 0) {
                    throw new Error('الملف فارغ أو غير صالح');
                }

                // Robust Level & Class Extraction
                let detectedClass = 'فوج غير محدد';
                let detectedLevel = 'السلك الثانوي الإعدادي';

                const fullTextTop = rows.slice(0, 10).map(r => r.join(' ')).join(' ');

                // 1. Detect Class Name (e.g., 1APIC-1, 2APIC-3, 3/4, 3AC-2, TCT-1, 1BAC-2, 2AEP-1)
                const classMatch = fullTextTop.match(/([1-6]\s*(?:APIC|AC|AEP|AP|AS|TCS|TCT|1BAC|2BAC)[^\s,]*|\b[1-6]\s*[\/-]\s*\d+\b|الفوج\s*:\s*[^\s]+|القسم\s*:\s*[^\s]+)/i);
                if (classMatch) {
                    detectedClass = classMatch[0].replace(/الفوج\s*:\s*|القسم\s*:\s*/g, '').trim();
                } else if (file.name) {
                    const fnMatch = file.name.match(/([1-6]\s*(?:APIC|AC|AEP|AP|AS|TCS|TCT|1BAC|2BAC)[^\s,.]*|\b[1-6]\s*[\/-]\s*\d+\b)/i);
                    if (fnMatch) {
                        detectedClass = fnMatch[1].toUpperCase();
                    } else {
                        const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/^export_notesCC_/, '').trim();
                        if (cleanName) detectedClass = cleanName;
                    }
                }

                // 2. Strict Level Deduction from Class Name first (prevents "التعليم الأولي" false triggers)
                const normalizedClass = detectedClass.toUpperCase();

                if (/^1\s*(?:APIC|AC|AS)|1\s*[\/-]/.test(normalizedClass)) {
                    detectedLevel = '1APIC';
                } else if (/^2\s*(?:APIC|AC|AS)|2\s*[\/-]/.test(normalizedClass)) {
                    detectedLevel = '2APIC';
                } else if (/^3\s*(?:APIC|AC|AS)|3\s*[\/-]/.test(normalizedClass)) {
                    detectedLevel = '3APIC';
                } else if (/TCS|TCT|جذع/i.test(normalizedClass)) {
                    detectedLevel = 'الجذع المشترك';
                } else if (/1BAC|أولى\s*باك/i.test(normalizedClass)) {
                    detectedLevel = '1BAC';
                } else if (/2BAC|ثانية\s*باك/i.test(normalizedClass)) {
                    detectedLevel = '2BAC';
                } else if (/^([1-6])\s*AEP/.test(normalizedClass)) {
                    const pNum = normalizedClass.match(/^([1-6])\s*AEP/)[1];
                    detectedLevel = `المستوى ${pNum}`;
                } else {
                    // Fallback: Check header text ignoring the Ministry title
                    const sanitizedText = fullTextTop.replace(/وزارة\s+التربية\s+الوطنية\s+والتعليم\s+الأولي\s+والرياضة/gi, '');
                    if (/السنة\s+الأولى|الأولى\s+إعدادي/i.test(sanitizedText)) detectedLevel = '1APIC';
                    else if (/السنة\s+الثانية|الثانية\s+إعدادي/i.test(sanitizedText)) detectedLevel = '2APIC';
                    else if (/السنة\s+الثالثة|الثالثة\s+إعدادي/i.test(sanitizedText)) detectedLevel = '3APIC';
                    else detectedLevel = '1APIC';
                }

                // 2. Locate Table Header Row
                let headerRowIdx = -1;
                let colMassar = -1;
                let colName = -1;
                let colFirstName = -1;
                let colLastName = -1;

                for (let i = 0; i < Math.min(rows.length, 25); i++) {
                    const row = rows[i].map(c => String(c).trim());
                    for (let j = 0; j < row.length; j++) {
                        const cell = row[j];
                        if (/رقم\s*مسار|Code\s*Massar|مسار|رقم\s*التلميذ/i.test(cell)) colMassar = j;
                        if (/الاسم\s*الشخصي|إسم\s*شخصي|Prénom/i.test(cell)) colFirstName = j;
                        if (/الاسم\s*العائلي|إسم\s*عائلي|Nom/i.test(cell)) colLastName = j;
                        if (/الاسم\s*الكامل|إسم\s*التلميذ|الاسم|الإسم/i.test(cell) && colName === -1) colName = j;
                    }
                    if ((colFirstName !== -1 && colLastName !== -1) || colName !== -1) {
                        headerRowIdx = i;
                        break;
                    }
                }

                if (headerRowIdx === -1 && colName === -1 && (colFirstName === -1 || colLastName === -1)) {
                    window.openColumnMappingModal({
                        file: file,
                        rows: rows,
                        detectedClass: detectedClass,
                        detectedLevel: detectedLevel,
                        resolve: resolve,
                        reject: reject
                    });
                    return;
                }

                // 3. Extract Students
                const students = [];
                for (let i = headerRowIdx + 1; i < rows.length; i++) {
                    const row = rows[i];
                    if (!row || row.length === 0) continue;

                    let name = '';
                    if (colFirstName !== -1 && colLastName !== -1) {
                        const fn = String(row[colFirstName] || '').trim();
                        const ln = String(row[colLastName] || '').trim();
                        if (fn && ln && fn.toLowerCase() !== 'nan' && ln.toLowerCase() !== 'nan') {
                            name = `${fn} ${ln}`.trim();
                        }
                    }
                    if (!name && colName !== -1) {
                        const n = String(row[colName] || '').trim();
                        if (n && n.toLowerCase() !== 'nan') name = n;
                    }

                    const massar = colMassar !== -1 ? String(row[colMassar] || '').trim() : '';

                    // Validate valid student row (ignore footer/summary texts)
                    if (name && name.length >= 2 && !/المجموع|الإناث|الذكور|الملاحظات|المعدل|النسبة/i.test(name)) {
                        students.push({
                            name: name,
                            massar_id: (massar && massar.toLowerCase() !== 'nan') ? massar : 'غير متوفر',
                            status: 'pending',
                            final_level: null,
                            stages: { LTC: 'N/A', CTC: 'N/A', LP: 'N/A', CP: 'N/A', LTM: 'N/A', CTM: 'N/A' },
                            order_number: students.length + 1
                        });
                    }
                }

                if (students.length === 0) {
                    window.openColumnMappingModal({
                        file: file,
                        rows: rows,
                        detectedClass: detectedClass,
                        detectedLevel: detectedLevel,
                        resolve: resolve,
                        reject: reject
                    });
                    return;
                }

                resolve({
                    className: detectedClass,
                    level: detectedLevel,
                    students: students
                });

            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = (e) => reject(new Error('تعذر قراءة الملف'));
        reader.readAsArrayBuffer(file);
    });
};

// ============================================================================
// Manual Column Mapping Fallback Service
// ============================================================================
window.ActiveMappingSession = {
    file: null,
    rows: [],
    detectedClass: '',
    detectedLevel: '',
    headerRowIdx: 0,
    resolveCallback: null,
    rejectCallback: null
};

window.openColumnMappingModal = function({ file, rows, detectedClass, detectedLevel, resolve, reject }) {
    // Sanitize initial class name from filename or detected text
    let initialClassName = detectedClass || '';
    if (!initialClassName || initialClassName === 'فوج غير محدد') {
        if (file && file.name) {
            initialClassName = file.name.replace(/\.[^/.]+$/, '').replace(/^export_notesCC_/, '').trim();
        }
    }
    if (!initialClassName || initialClassName === 'فوج غير محدد') initialClassName = 'فوج مخصص';

    // Sanitize initial level to standard categories
    const validLevels = ['1APIC', '2APIC', '3APIC', 'الجذع المشترك'];
    let initialLevel = validLevels.find(lvl => lvl === detectedLevel) || '1APIC';

    window.ActiveMappingSession = {
        file,
        rows,
        detectedClass: initialClassName,
        detectedLevel: initialLevel,
        resolveCallback: resolve,
        rejectCallback: reject
    };

    // Populate Level and Class Name inputs
    const levelSelect = document.getElementById('map-select-level');
    const classNameInput = document.getElementById('map-input-class-name');
    if (levelSelect) levelSelect.value = initialLevel;
    if (classNameInput) classNameInput.value = initialClassName;

    // Detect header row index
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
        if (rows[i] && rows[i].filter(c => String(c).trim()).length >= 2) {
            headerRowIdx = i;
            break;
        }
    }
    window.ActiveMappingSession.headerRowIdx = headerRowIdx;

    const headers = (rows[headerRowIdx] || []).map((h, idx) => ({
        index: idx,
        title: String(h || '').trim() || `العمود ${String.fromCharCode(65 + idx)}`
    }));

    const nameSelect = document.getElementById('map-select-name');
    const massarSelect = document.getElementById('map-select-massar');

    const optionsHtml = headers.map(h => `<option class="bg-white dark:bg-[#0B0F19] text-slate-800 dark:text-slate-100 py-1.5" value="${h.index}">${h.title} (عمود ${String.fromCharCode(65 + h.index)})</option>`).join('');
    if (nameSelect) nameSelect.innerHTML = optionsHtml;
    if (massarSelect) massarSelect.innerHTML = `<option value="-1">-- غير متوفر في اللائحة --</option>` + optionsHtml;

    // Intelligent pre-selection
    headers.forEach(h => {
        if (/اسم|nom|prenom/i.test(h.title) && nameSelect) nameSelect.value = h.index;
        if (/مسار|massar|code/i.test(h.title) && massarSelect) massarSelect.value = h.index;
    });

    window.updateMappingPreview();
    const modal = document.getElementById('modal-column-mapping');
    if (modal) modal.classList.remove('hidden');
};

window.updateMappingPreview = function() {
    const session = window.ActiveMappingSession;
    if (!session || !session.rows) return;

    const nameCol = parseInt(document.getElementById('map-select-name')?.value || 0, 10);
    const massarCol = parseInt(document.getElementById('map-select-massar')?.value || -1, 10);
    const tbody = document.getElementById('map-preview-tbody');
    if (!tbody) return;

    let previewHtml = '';
    let count = 0;
    for (let i = session.headerRowIdx + 1; i < session.rows.length && count < 3; i++) {
        const row = session.rows[i];
        if (!row || !row[nameCol]) continue;
        const name = String(row[nameCol]).trim();
        const massar = (massarCol !== -1 && row[massarCol]) ? String(row[massarCol]).trim() : 'غير متوفر';
        if (name && !/المجموع|الإناث|الذكور/i.test(name)) {
            count++;
            previewHtml += `
                <tr class="hover:bg-slate-100/50 dark:hover:bg-white/5">
                    <td class="p-2.5 font-bold">${count}</td>
                    <td class="p-2.5 font-medium text-slate-800 dark:text-slate-100">${window.escapeHTML(name)}</td>
                    <td class="p-2.5 font-mono text-slate-600 dark:text-slate-300">${window.escapeHTML(massar)}</td>
                </tr>
            `;
        }
    }
    tbody.innerHTML = previewHtml || '<tr><td colspan="3" class="p-3 text-center text-slate-400">لا توجد بيانات مطابقة</td></tr>';
};

window.confirmColumnMapping = function() {
    const session = window.ActiveMappingSession;
    if (!session || !session.rows || !session.resolveCallback) return;

    const chosenLevel = document.getElementById('map-select-level')?.value || '1APIC';
    const chosenClassName = (document.getElementById('map-input-class-name')?.value || '').trim() || session.detectedClass || 'فوج مخصص';
    const nameCol = parseInt(document.getElementById('map-select-name')?.value || 0, 10);
    const massarCol = parseInt(document.getElementById('map-select-massar')?.value || -1, 10);

    const students = [];
    for (let i = session.headerRowIdx + 1; i < session.rows.length; i++) {
        const row = session.rows[i];
        if (!row) continue;
        const name = String(row[nameCol] || '').trim();
        const massar = (massarCol !== -1 && row[massarCol]) ? String(row[massarCol]).trim() : '';

        if (name && name.length >= 2 && !/المجموع|الإناث|الذكور|الملاحظات|المعدل|النسبة/i.test(name)) {
            students.push({
                name: name,
                massar_id: (massar && massar.toLowerCase() !== 'nan') ? massar : 'غير متوفر',
                status: 'pending',
                final_level: null,
                stages: { LTC: 'N/A', CTC: 'N/A', LP: 'N/A', CP: 'N/A', LTM: 'N/A', CTM: 'N/A' },
                order_number: students.length + 1
            });
        }
    }

    if (students.length === 0) {
        if (typeof window.showToast === 'function') {
            window.showToast('تعذر استخراج أي تلميذ بناءً على الأعمدة المحددة.', 'error');
        } else if (typeof window.showCustomAlert === 'function') {
            window.showCustomAlert('تعذر استخراج البيانات', 'تعذر استخراج أي تلميذ بناءً على الأعمدة المحددة.');
        }
        return;
    }

    const resolve = session.resolveCallback;
    window.closeColumnMappingModal(true);
    resolve({
        className: chosenClassName,
        level: chosenLevel,
        students: students
    });
};

window.closeColumnMappingModal = function(isConfirmed = false) {
    const modal = document.getElementById('modal-column-mapping');
    if (modal) modal.classList.add('hidden');
    if (!isConfirmed && window.ActiveMappingSession?.rejectCallback) {
        window.ActiveMappingSession.rejectCallback(new Error('تم إلغاء تعيين الأعمدة.'));
    }
    window.ActiveMappingSession = null;
};

// ============================================================================
// 3. Client-Side Official Excel Engine (ExcelJS)
// ============================================================================
// Embedded Ministry Logo (Base64) - Works 100% Offline with Zero Network Calls
window.MINISTRY_LOGO_BASE64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAACagAAAHPCAYAAAC8gK9nAAAABHNCSVQICAgIfAhkiAAAAF96VFh0UmF3IHByb2ZpbGUgdHlwZSBBUFAxAAAImeNKT81LLcpMVigoyk/LzEnlUgADYxMuE0sTS6NEAwMDCwMIMDQwMDYEkkZAtjlUKNEABZiYm6UBoblZspkpiM8FAE+6FWgbLdiMAAAgAElEQVR4nOzdd5zcV33v//f5TtnZ2apddUuyZMlFlotc5C5bphgb4orpBhySmwQCvwukkdx7E//uLwkkJEBILj8DAQwkoQcbYgw2tgXuDctNlouK1etq6+y07zn3j5nZnV52drUr6/V8PMa7M9/vOefz/czZXfn7/cz5GuecAAAAAAAAAAAAAAAAAACYbN50BwAAAAAAAAAAAAAAAAAAeH2iQA0AAAAAAAAAAAAAAAAAMCUoUAMAAAAAAAAAAAAAAAAATAkK1AAAAAAAAAAAAAAAAAAAU4ICNQAAAAAAAAAAAAAAAADAlKBADQAAAAAAAAAAAAAAAAAwJShQAwAAAAAAAAAAAAAAAABMCQrUAAAAAAAAAAAAAAAAAABTggI1AAAAAAAAAAAAAAAAAMCUoEANAAAAAAAAAAAAAAAAADAlKFADAAAAAAAAAAAAAAAAAEwJCtQAAAAAAAAAAAAAAAAAAFOCAjUAAAAAAAAAAAAAAAAAwJSgQA0AAAAAAAAAAAAAAAAAMCUoUAMAAAAAAAAAAAAAAAAATAkK1AAAAAAAAAAAAAAAAAAAU4ICNQAAAAAAAAAAAAAAAADAlKBADQAAAAAAAAAAAAAAAAAwJShQAwAAAAAAAAAAAAAAAABMCQrUAAAAAAAAAAAAAAAAAABTggI1AAAAAAAAAAAAAAAAAMCUoEANAAAAAAAAAAAAAAAAADAlKFADAAAAAAAAAAAAAAAAAEwJCtQAAAAAAAAAAAAAAAAAAFOCAjUAAAAAAAAAAAAAAAAAwJSgQA0AAAAAAAAAAAAAAAAAMCUoUAMAAAAAAAAAAAAAAAAATAkK1AAAAAAAAAAAAAAAAAAAU4ICNQAAAAAAAAAAAAAAAADAlKBADQAAAAAAAAAAAAAAAAAwJShQAwAAAAAAAAAAAAAAAABMCQrUAAAAAAAAAAAAAAAAAABTggI1AAAAAAAAAAAAAAAAAMCUoEANAAAAAAAAAAAAAAAAADAlKFADAAAAAAAAAAAAAAAAAEwJCtQAAAAAAAAAAAAAAAAAAFOCAjUAAAAAAAAAAAAAAAAAwJSgQA0AAAAAAABois0+AAAAAAAAABQLTncAAAAAAAAAwMyWV3zmsl/NtAQCAAAAAAAAHHUoUAMAAAAAAADKyhSm/eFHPyzPWQWt5DkpGm1XMp3WcDqhZDqlr37la9McJwAAAAAAADBzUaAGAAAAAAAAVJRWQMMKmKRaTFpBGbnRQzIyChon6wUlpcVpNgAAAAAAAKA8zpwBAAAAAAAAZXmS4mrx9iqoAbUoqYBLa3R0RCYYVjjYpkCgR1JSUniaYwUAAAAAAABmJm+6AwAAAAAAAABmrrQCZkAt5qCCpk8h0xdIJ7df5dLbvZDbr4AZVmYFNQAAAAAAAADlUKAGAAAAAAAAVGTVGs48Aum0hvv6FscH9b2R/uSSgJIKyZdkpztIAAAAAAAAYMaiQA0AAAAAAACoYnh4VC0tLZJLyNrUukvW9na0t+uy1taoPK9FnGIDAAAAAAAAKuPsGQAAAAAAAFBRUM50qu9wXF44oUiH3vumq1Yq0Kr3JVNGo4mIpOB0BwkAAAAAAADMWJw9AwAAAAAAwOtYUlJMUrro9Uq35Sx+PSbfjirc4WnTM6O9b36j3twz1+nUU/Xmr317++zzLlxyUDooaTi7f6OfBy3en9uFAgAAAAAA4PWFAjUAAAAAAAC8jsV00w1nKaTDhS8bK2udrE3LWivfpuScK21upLdes07zZ83W6L7t7zznzAWSGdGJK0I6bknqnatOD3zpfVcvkzdWV+bJGsmYTOGZZ4wkT8YYyWW+WpM/gKfOzs6851ZeURimpGjNViyDK1fe5kzxK4WtjSvtrTCGol6NLXgl13/uuEriL0mrV7TP+Pi2JFbJmdLjr95/jTJB5xWM47J7V4yf/Be9Qv7Jf3nkv7jHMsg/+c/vn/wXjE3+C5F/8l88Pvmv1j/5L+y/dHzyn9c/+S8Ym/wXIv9Tm38K1AAAAAAAAPA6llZIhxU2AyVbnJF8kzmxZo3kJKnoZJ6V1N6aVjw+qLlz9f4F8zul0T4tXjxbS5fteb9v93wp5EkBN97CGclkT2qabH9jX73sOHlaTLzgefEJSa/4hGhJD0XHVfS89KRr4QteyQnL4l2KT1C6gnFy/edOVBYPV3z60zhTtFPhHsUnVG3JCeLCIyzpX7WYgnFyp3srx0/+C5H//HHIf7XoyH8p8k/+8/sn//nPyX/h/uSf/Be2Jv9V+1ct5J/85/dP/vOfk//C/cn/1Oa/ajEfAAAAAAAAcExxRQ9JHdEOffMbzy5aMF8XBgIjGh2Jqb21XYsX6oIf/+jlxZ6t0r6or2Km9tlMAAAAAAAA4KhGgRoAAAAAAACOGc5lHtaOf++sKhaVeU4aHuzXrG69Z9UZ3bJeUn2HY7K+p/PPXaUlx+m9vpU8k3lYO/YB05JxM9+UbvPteIVbubZHC+OIfzoR//Qi/ulF/NOL+KcX8U8v4p9exD+9iH96Ef/0Iv7pRfzTa6LxU6AGAAAAAACAY4qzmUIya7PFacorIJNKitTS8SHNm62bjls2Vzbo6e77Y4ongjruuG7Nm6ObjJOCAckLSulUtp0vGZv5Kn/8xJ1zytwxITuuMZLLFqjl9vGKHjOdly3kG39uCh5HnDOFjxqK89x8/k3RY2qR/2Lkn/yTf/JP/sk/+a+F/E8y8k/+yT/5J/8i/+S/ZvspjA0AAAAAAACYWbLFYSbvUW0FNSPprjufP+n003RG97webduxV089qY179wypd0G7li3VaaGATnEpSelMoZpLl560c1YquBWosp84NZIrqI4r2gkAAAAAAAA4ygWnOwAAAAAAAADgSPByt/R0ks3WhBmbKULLrxEzrrBNd7fee+ppx+vA7p3auFFb+g/rssce3f7YGRfMPeGC8xbqsft2v2+4X//LGikUyja0krzCT4caZYvUsh8qdUYKZB8mt5SbsWVvAyo5mTo/ampUVOZW87YLhUVx5T/0Ot5Js5/JdQX3gSiJNhNRySD13zui1od2TaXxc+0q5L+RSErjL99XueMn/2V7bSgS8l8Z+Sf/ZcfPbSX/5XptKBLyXxn5J/9lx89tJf/lem0oEvJfGfkn/2XHz20l/+V6bSgS8l8Z+S88AgrUAAAAAAAA8DpmZWQVcJojaamMXpUn35Mkk1nBzNjxgjVnlH8uzhpPocXH66bFi7sUCqb1/AY99Z53dR589LHBpx578MkTWqNSJKz3DTp93knJ1jZ5iVFJXqbvMUYygcypQCdJTgFJK+S0VdLBzP1AK6n/5GjmiKuZyOnFxsZvvO/CmJo5OTwZ45ffp37VTw5P/fiNIf/kn/znI//Njd8Y8k/+yX8+8t/c+I0h/+Sf/Ocj/82N3xjyT/6P5fxLpvAWAgAAAAAAAMDryX59958+pGeevHPx4JD++YQV5trV5yzzh2N7B+OJmMJByaSkSEhKOWk4JnkRaTQhtbeF7MaNqeA556jrbW87V/f89Em99Lz6jl+qhG8VsQHNCrVISkuyGowllIq0ypOXXa3NDymZTMvznGKjUiwhLVjUqp6ekzqfemJbYNOLA3ckE/poZ5fZGfRKz9HlVkyzUsE5xDK7VmVVvPSaN7aleM/8rXVzRS2Kiu2KR2m0/+LjLz1f6hU9m9zbpNbMf4PHXwv5rz4++S/eg/w3Mj75r478Vx+f/BfvQf4bGZ/8V0f+q49P/ov3IP+NjE/+qyP/1ccn/8V7kP9Gxi/unxXUAAAAAAAA8DpmNTIyqNNXnbRjJD5y3cDQ7r9NpVJ/fsml58/q6k7Ipg/LSyXl0lahUFRq75QCUcmFZdNSLHaXli2T9ux4Vft2Sb/1ttU9S09dLCX7pDajwX17ZH3JC6izc1a3rE3Ki3ZJ1pPiUiI2rECLUyKVVCjcpWSiXfev36TdewY+vWOX/sf1117gnn/+sapH4ElT/SHWma3Ze0o06WjPf8MnnItVPTk/9ch/3vfkv2Hkf3qR/+lF/qfXpOZ/GpD/vO+Z/w1j/k8v5v/0Yv5PL+b/9KqVfwrUAAAAAAAA8LrW1tkhf6RP4fB8Hbdg0V989cuP/dszG3bc+rarT1o7b4FTV3tcQ7EhvbZ5j17bEU+2tkd2t3X0LjncN+oP9il03MLjdGj/AfUdlja+uNXfumV7IJWO+zKJQChkdHggrc5OKZ1W0vdljKftQ0NaNHuuWlauOk6+HdWC+Sfp2af7dPfdDz/w7HP68LU3XPHCqlVO8cSwPC8oKSUpcy603LlIz2VuGZq5fUNjZ6y97EdYK936od5P/Foz/und/E/x1mrd8CeWi+NseMW4yhHkjrUg/jrSmdvfGknOK2xTs31+Bux4m+LjMgV7jMvbL3Oy2mss/rz9bXYy2Crjl7YvfqH6O0r+i9uT/5LoyP/4/uS/YPzS9sUvHF35b/oCaYVYcmr+9c7Pv1HJCheNjleyYkaxWvkojr/R/DfIq7HCR8P92cL+pj7+GjvU+jkqOv7if+9NZP43gvlfvT/mf31tK2L+V8f8L3yB+V/wnPnf2HjM/8md/5M9PwAAAAAAAIAZxNPgcEwpG5TxInIuomuuPnvjvPnLL/3CF17+i4cfelXxVFht3b3yjfTii/K/emv8a/9x267gv3+z75rTTpmr1tZebd6S1Esv68M/+9nA0u9/v2/Ff/00tvSrX/H/YPfutFaeuki7d0nf/46u7emaG/7m1/WVAwflz5vXq2hrt+bNW6m7f/GcPv+Pm/7nsqXnX3rl29a+EEv68o2n1raoXPakXe7cnck+PDf+GDuaRj9JW8/J5EZPOOfHkD35W/Cw3thjxikqrpBq57Sp/Jf21mwHzcU/3e8J+W96/KaQ/6bHbwr5b3r8pkx7/icf8U8v4p9exD+9iH96Ef/0Iv7pRfzTq9n4WUENAAAAAAAAr2OefBNRygTleWm5gNTRPVtynTr3PPPpe3756p2PPLb1y+97f9sFp597gpadNNr63FOv3XLXnbbfGC084/QVcjall15R/2WX99xqk91qbQmp7/AhXRwJfjlp93565ZmLZ81fFNGWV1+97J579p/4iT8OfPqCS872ZNu05eVD+v//+aEn+gf0++vecM7TkY45io/uk/Xisi4q30nG2bGCtHxGGiteKziiWp/ALSk4q1QUkHvdZto08snagjE8mQonKb0yXdpyLzakVpFD40UQzZ34zcvjBMeX1MRtPHJFF9nxGyw4nIzxMyZ+/OS/ufEzyH+mH/I/IeR/asYvKjKv+Xe2KH8lfy/L5Le4aLyasSLBOv/eF//7ojRXRcdfHH/Jv2HKrHFXLf6iOGsWOdYYv9njL9XY/K+5Ym2N97/Z4x/bnnf8jcz/Zt//Zo+f+c/8b6g9879wX+Z/2X4rYf4XYv6X9Jjbs+z4zP/ivQvHpUANAAAAAAAArz+5E37GKh1Iyyktz5NcwNP+wSGFvbC8lnk6ZZV9dtkJ3oX/50uv3vLWKzf+1eVrT9PlV705sGD2hn++9759evLxh7X81OXatUPf6I52yfrtingR9c6O6vDh/Xp1q77xwqZnP7lo4VzNn69PnXLyLF1wyakaGezXPT97Qk89of/v7DVn/uVook3OdOrwUEzpllGlvbSsggr5QTnnZFyF6/NOY+c/nct/cZxxRScRXXFPE7gvRDVFJyArFadltnlyTd5SYqrl4i9XDFjCeZOezoaUOfnbUPxNm/wVkMh/I8h/MfJ/BJH/hvLvOUnW1XkT7VwQxRXoef+ckWSL/r5P+PZPzlT/4z22X974zsiW/EvFFX0t0z63Smzxv1VUFH+54y/pr8FqwuLxx16fnOP3svHYevqqOVbj73/tPqsff0Pzp+z709z7X7N/5n9Rf8z/xvpk/lcci/lfX3vl2jP/mf/M/3zNzn8K1AAAAAAAAPD64Mp8b9JKh/rlm0EFXbesQvLlaTSeUjBk1dY9T8mE9O63z7nl7z/9yJ3PPv78l2+45vBZp65ZpRNWtOmhh7fo61/ZrH179aOlCyLqnTVPsdEBtbeF1N3bo1fv3fXDTS+OfHLRwqBOOjmkYMBp4MCovvH1F557aYN+/93vWffIjkMH5by0RmKD8tqM5CVlg07Ol6w8+TIKlruCnT2p6GW/jp2XLLqSXnpitugEoql98tZzKlt8kInDZk+eloQ2IdU+AVx5dbVmChPy22b6Hz+XWrqtmMnLi5tQLNXGqD1+6XiVV6wrpyD+kmLBiY3fGPKfQ/7Jfyam+scn/0d3/p1zDaxQ4kpiyv/b7TR+QbAwpsqXNb2KK1oUHW+FP+r5ezm5Mv1VjyD/3w5OKllVtfCfNaXHX5K7Bi/QWuMVjj/WfHKO32U7dxWOv7HV+Rp//2updfwV/lk5pjD+4vgKeqgwvqq+/6V9Mf/zR2f+F21l/jcwOvOf+c/8L4/5X2Ca5r9xjVbcAQAAAAAAADNRufOE3n599gvvk8yAgrZHAa9T0XCnDh8+JD89pM52oyVzuuWPHlY6MaSutpTuuvPpvzzvPP3JNdcsa29duES/efBlPfTwnueefFJ/dv21F92VTo/K17B+/cArVyxfob/vnqUzr792pQ7uGtKPv79zZGhE//iGy1f9VSS0XMMxp50Htina3iHndWgkOSTTdli+Z2X9HgVtUM8/8qCCtvQcXa4wzfMyn3R1Fc6D1io+C3i1PqNax/ouucIC55Wex6xxS4cJraCW32ZCt4yr3MZUOF5XsE9lrmLf+f1Wi7m5FeVMhXzk57nSPsX7TUxzx0/+yX8zyD/5L28m5T/v1XSjx1s8uhv7G+9lnpYfJ6+ZV99ycHVHVF/flfsbi7/KkONjmNKL4qbwaW2Vi/jH+278+DNtyx9//goizd0ytvL7X3/f5Y+/tNigdJ/aY0z8/a/dd7n+mf/M//FnzP96xmD+l++b+Z/fb7l9ao/B/G+0P+Z/ZRSoAQAAAAAA4PWj+FSXSUoaVObicViZGwp4kktLJi5pUN/+4l+ot9PTSN8BtYZGNXvWqO795YaDK1epd8GSkC68/AwlfacHHtykxx+Pff6xh/TFnl595F0f0J+su+xM/eKnz2h+T5fOPWuVbv2Xhw8tX7xm9ki8W4GuNg0nh/TEQ/dlAwvIGltwTzHPeQp5fsEJvdzpOperCQtkvma/1H0ri7H22f7yhx7bp47V1XLGLsvXcYK4GZ4rirNWvw2c3sw/t1wt3mq3DSmJr1m1Tj6b8W1TEn8D4zeL/JP/EuS/BPkvP36zjnT+nZFMqP748sce+7ud/cOfq2Gv55ZWnjVyLnNhNxAw2fb1BV1r/Gbb1xW/y7S3kgITGd9ljl9GMpN8/Eck/irj19W+yvEfFfFXac/8r2N85j/zn/nP/Gf+M/9n+PznFp8AAAAAAAB4/TAqvJDtwpKbnfc8bz9FJWM1e848pUf2KOBF1RIO6ktfeuQdf/TJZb1Lls7Tt//jUW3f85RuePf5Wvem1dq24+FPnH+JPv7u95xslixrVTrptHe31LdnQGevHtXatQt7b/38Ezde9673/fBAekAtne2y8hSULylTiGZs/idM7VjIYyf+XF6IytTSSeOFasbVKAZz2WIyW9jP2Ot5ObDZ14r7K/cJWJPbV6p4O5Bm5S7+N/UJ9OK2+bHazLE6lT/uXAz53xd/+jiXhwmNX25bpWMt97obz39xbPkx5n9fNv78n4NGxq8H+S/4nvzX2Eb+C5D/KuPXY7rznz9c9u99xb/XRbF6eS/lCsyNycaczdtY6nKxFffhJKfMiqvGSTZ7QK7aQm7ZfqqOX8dCcA3HX6UPZzNh5e4IXvH6av77NbZfdsVZJxnjasdf5/Hnb5+U+Bt8/8tq4Pgrxp83jyrGPwnvf7XY62nP/C+D+V/YnvnP/Gf+M/+Z/zN//osCNQAAAAAAALzeFF8MLj4xZvIeSutg33YFU/2a3b5YfmKXTlyp9y86QZo1b1Sze/XUd7+u333iocf+5aSzdHHvPOm3rl5g5i2cpcd+/azuvTv26Man9ZFzz9KXrT+yZsXJPTr+hN0fsN6hH4ZDVp4JyJMtWHFl/AJ44YnT3Mm+klt55o7Hz3zvyhxisfx9igveyqlUkCapbDFa/vE0WqzWVPHZRJQ7tuzLlYos8pWNN/+1et6MatvqzV/efDBOVYtE8lXN90TGLzaB4yf/TYxfjPxXRf5rbCP/VTWb/9yF0mrx5G/K7Wuy/7F5heb5250pf5Gw5EJguq4wx8fPfp8bx/oTbJ/9WjH+7GvF+S+Jv9b4rvDbgvypifjLHH9J/icSfxPvf8VGldrXG39+H5M1f3Ljl/mgRNX2zP9CzP/q8TP/C/tg/heOz/yvHT/zvzR+5n9J+6mY/xSoAQAAAAAA4JgWDknBgFU8eVj337u++7QzdVW03eq1V192GzboM3/2p6s3/PCODXbNOfN04qoeBULSnXc8qm2bpXRC9oMfWPT0L+/Z+ZkdO3b9cPnK08y84/TWH//0592XXbOmP2Tb5ckpUOHTq86opCAtt2v+KjPGZTfnnRysqah9yYV2p7pXRCtZ9aaMei7211IpzrqLGOrhcuvf2Ib7bXp1t/zxTR0fyZ5kxkmenb7xJZF/8p/tjPyT/2lwBPPvKXOBsuDva632rvD7grZ5F5Ndmd2lMhcIG+WqPm28ffFyc9m3PXdcNePPf17u/aq2f5nNNdVq32z+m33/a/U31fHXUuv9Z/5nXmf+197O/Gf+M//HMf+Z/zXGO9rmPwVqAAAAAAAAOKYlk75aWwMy/oD2H9INZ69pCba2d2r9Pa/F9+7S2wbiG775mX86L6pQXHv2Htadd+yQ50m/9wfnKpWIX3TfL54fHYnre7+6b2R0+Skd0dPPmRN4buuBt7e0pr6WSIxKqnxR20oyRR+5LS4Ey31iNf91m9df2eIyV+H7KZD/ieB6b31Wk/MKCxicJrdILc/YrVUn2n/R+9W0GiecizUdf5PjN3v85L+58cl/5iv5n2D7Sv1Vel6E/NcY343/jZyIWquvjZXb1Rl/o7E0E7tUuw6xofxPIJdNx9/s/C9q31T8EziWpuNvsL+S/ZusQ2X+52H+N4z5X6W/Kdi/pD3zv6l4mP95T5j/r7v5P2nnjAAAAAAAAICjUSKRUKTVUyK9T+ddpJtWnLRQfQd3yQso8uGPtN385ivPjAY7pbt//qxu+Z87bv3ON3XGzq269Z6fP6lYLKYrrzo3csM79MGWiFoP7d6q5Sf1qq1LN4XDIQW8lqon+DxX34osXtFJ2vx2Jf1P5IRklTYlJxSr9V9umyt6TJTL+zoJRXcN1SNM0pgV+56Ahk48V4t/qo6rBvLf3PjNIv/Njd8s8t/c+M2aMfmfoIlceGz2YuVkIv7pRfzTi/inF/FPL+KfXsQ/vYg/gxXUAAAAAAAAcEzr7upQbHSzfnH3q/OvfLMub+9p18u7turdH1hiQvOWqv+1fbr9288c2Pi8/tsNV511h7lijmSSH/7Bv62/a8fWLV++8qrU/De8dY2G9mwz/X1b1Bbt1amrtO7fvv3EgqvfeuUeuYA8+RXHt6709pi57/OLwYpP7jmT1y7/U6zZ13O713Mh3mj81gzl9i8uSst/3ujKMzVPbJbcEyN/W2NjlevTy35m10oysnXd3rQgpvwY6v14eMExeeP95No7VX+j8uPPe68nFH+T4xd23vjxk3/yP9YP+Sf/DY5f2PnMz39J5M1eZMzGa5WJra748+OpdIvVXD/1/n2u1L6W/PnjygxX9EJxtzVX3Gg2/jrbW89OLP+T9P5XNNXx15o/tTD/JTH/J4z5L4n5X6v/ytuZ/xLzn/k/M+Y/BWoAAAAAAAA4iqUlF8t8Nfmn7qykeOZrwRk9q8wLVlJS0qA8l5D8tFpb9c4ly8IaOLhHi47rljynR3/xa/3yl/q71WeEPnXZpQtk5PT9H97t3fT+S+zbr1v+E2sO/OSf/2nH31xzzY6/uPTSU5VKj6qtw9Ppp/foF7/oe1dHMPCFgMueCKxwZjEXjZzkFJDNfCNrMg8v80rZE6Dlitryv88/Geib0pOD9RaXVTpnWWn8gnFqjlGYGD+Qa1+csAmeEJZXsu94rJ5s9kStyzvxXdi6sL2v/OPzxltUjKd0/IJtE2yfOYZM++L3oTD/My9+8j+98ZP/6Y2f/E9v/Ecq/1ZB+S4qufzLcM3c1MiO/dsgx41vyet9fIySsEx+iV5hv3XFOPbvrGrtq/EK4y/Ku1cUcOEFzsxetS/yNxt/9fY2r73Lfl+Y/7zdy7SfeJFCvXluNv5m588EY6uJ+S8x/2tj/ucw/4sw/5n/BS3G+60rRub/pM5/49yEfxoAAAAAAACA6eUGdetff0QhDSvlebLyZK1VwEuoNdKve+95eNWsTr1tztzI6ZGoXRgbTbrhQe2QtKF/QHdc+7YLt+3fNaLurpQ2737xsQ9+aP55ndGQZCP6wXdeeeZX6/VRa/XicUv0jgWLdW1rmxZbq3Y5DQ8NaEffQf3kpU36XktEJ7/pjfqXa6895exgdK+c36av/cuuJzsiC9acdNJKJeMD+uGPn1o6q1fXtrVrdVeXFsvJDAxo96FDem5wUHe+8fLTX3CmW4FQi0aToxqJj6p3Tpeefm6DXN6nXWutQNbM6maTpfoJ1Ozp4aLYGqppa9JUf4h9uuWvcjQTkf/pRf6nF/mfXkcq/2nXqX///mvymxiw3OW7OteNk4x0aGhvmU5rNfQkYwpHMvUeddElynIHMNZV0UXScu3L9llnKPVnqsJ4FdpXTUUdF+DH4s/Pb/b7sqsFTvSifu34e9vnlW53pfsVRNPAfD4wtL/K1irHXzDfvAbmX3H/ZYKt+wL/ROZP4Xs1p31O2agkTXjVoUZmw4FyP/81TeLPf9X8T//8L6/G+1/H/9/UZ4LHX/ePwkTizx+v+c3+/9cAACAASURBVPlfFr//S/tn/mf7Zv7X7PN1M/9ZQQ0AAAAAAABHNauQiyloBjPPPKu2aItGhrdry3Ob/vH6t+iTq1aeqNZoSF44oVQ6qWTCqv/wsDZvHvjHe+965H9cfP6Zf3f/fS/OvvxtOq+9s0cbfvOivvfv7n++tll3vuFS3XjpeQseOGXFcoXnd0vJuJROSbN6pIRbNbzz4JUvv7L9S48+vv3TP7tDNz/55KarbvqQ/u68S07Veacnz/2nf9gzd+Wfzt9/x51P/9maC/U3p5zaGZjV266WlpDkwkokEorHY3r5lYN/98rG5z638tQL/igY7NBIIq1Zs2Zp38GD8o0nZ8ZXqSm+OJg7V5h73S9azSan0jnNgnONxSeHja15LrS4vecKYyi4lYTzVFqgVriCTWWTfJK+7n5L19QpfL3R9s2Nb1zh+F6ZE/qFc6CwfWmej67jn+7xyT/5L3yd/Bcj/xkpG1HcZArVSozlpfhrYX+25A9wA/E6yWl2mbFr92fGClJy/VX6A13jD3fNv+vVj79sfA3VKk32+99o+zIK4i86flPH8TekevxxF6280Ullb2ObH3/Jz3/hc6fSAq1MH0Vr35jC9398/k3B8dcx/6u2L1C9fUztlfstyG+F+V8jv2X7zW9uyvz819HfpP3812wyvfN/Qu9/Q/Onlmk4/iM4/2vj93/BV+Z/0Xbmf4nX0fynQA0AAAAAAABHMU8JLyJrwvIDSRmTVNof0h3/uenDf/lnnZ88ZUWHZAYVGx2RH7dqCwUUDo2qe1FYZ5x2XGDh/H2f+emPntkTiihy8mln6O57n+277069ed9utVx/vX7+/t9ZO0/xBRpY/7Ke/sZGJfqt4qNppYNOC0+ap5VnLdHZF16os89Z/udzFtz/uz+5T9d84fM644ZND9/75vMunrNi2YEbv/Pdp4ff9f6Oz5y5+gQdOLRDbR1WyeSQJE9t7WG1RFq1cPHxmn9c/yc//7lHX3n7DWfd6qdnKRYLKBqZLbmtkkkXHHOB3Go1ZbLjymyxeSeAPVdUuFZycjjT3lY4oZvffnxlt/w+6vkE7/j+Viq9IFr2E9X1K7mhR4VPalf6zLBX8QRsvXEV71dvYUWtcRif8Wf++LZk9YPCn7/avRzdx8/4x/r4AAAAAHIoUAMAAAAAAMDRy0i+8eQZT9ZYeSatX/36N21vvVKfXXpcm/xUn1wgov6BEcVHnVqjnrpmtSiWjMnFkjrzrOO1Z/eeb256OTb8ve8+e8eePXqnl9Q5H/2deQ+vvep8JZ/dqu//3QNyB6Vgwiga6JXnRXRwcJ82/XqL7gtt0aqzpLfcfKHe8eGb5rR1/dsj96zXxXfdqQWHXn7oe72z9PcXrVHbGWfO1eDQLoWCUmwopoGBQckF1DmrTUMjCYXCEZ2yaq6uvn7gHx59/Olvn7fmDSPRaJtG0qN1rCxWqPwKNRVWZylYla30gruVl/20az3ty/Hquh2FM3mFYU0WpNUebLoLCxif8Y/h8af95w8AAAAAMB0oUAMAAAAAAMDRzaQLHtE2nbhs2dy27lnt2rf/sH792OGtW3ZotLdXpw4MWp162qguuXSV9ux/QTa1WWetWagXXoiFz1gx97qDu/a3Xr5OD69dc6Ze+/EBfe1/Padze+fq3JMv1Pylx2s4PqLBoT6FA05+bFB9B/q04YFX9dn1j+j9n43pre/5oBKxbz70q1+rvbs7cGM87o+esjKqZOqA/JQvz3To1Rf79OLzUjLpayQ+uHHlaWq9cO2sZd0dPZo/t63NdyMnhlrjG2zgkIKelUy6YNWz2ryCVcAyz/LaO69oRbTKrFG2QK2wfdlRTf4qaoXxlH2taF87VXUrLltAZ1TxuD2nvKXgigrv6iiwO6IajWemxX+0I/+NqfVzV9cqi5NpugvkGP+YG7/kNtflTHdephvHP8NdJ+kWSWdmn7+WfW3DpPR+zBcuc/zHNo7/2MbxH9uOzeM/No8aAAAAAAAArxNWAZdUQHF5SkuyeuI32vz8pv3DSbWoo3u+9uzV8MFDOnTFVedp7WVLdO89sg/8+iW1d8xXb0+bjl8Q1g1XtYZ/8+D+C2a16AvvuO4KHd60W//2t4/oilMv1jVrf1uBxCy99up+JUed5Idk0i3yEu0KxXt1+arrdMacU/Q3H3lGg/e8oGvfuFbzZutzjz3tX3D5lcsj7Z2tGhgYVCTSoU0v7dX69bKnnxnVO248TaOjOrR1q4ZD4aiGh402vTQyvHWLNg8OHZQXGNXI6GHVKuDIXzHNGa/M3vm30CxfnGZN+Uem09rFaY2p3IczpY96lWuba2+rFMnkby/er1Y7AJXV9XN35MIBpttqSTdnH91N9LNO0m3KFAf1S1qffQ2YbN3KzLUfa7w4TZKOV2berT7yIR09nKtYob5a0sc1+b8LbhfvCQBghqNADQAAAAAAAEeHsqtZpdWiYYXdsAIuKeOkD968cuiFl/Sxe3/9skxwln7rrXNOf+d1WttiXtPqk+eoU/rl0/enf5g4nJIdTCgwNKiegFO79O0LV3W9S8Md+vGtz2t+XDp/xZnasvsVxaNxtbRJ6WRMsk5WQcVCbUq1RBSL79Pinl4tDUrf/9yT8nrm6ezT9a50WN8O9xqFAm0KmXaNjgb0xJP6YSCiX55x9klq6RrWNTdo7dvfGz092t6phx96WVte1cfed9OpQy0trRoaGtGs7vzrVlaVyjkyxVi54jRP1njZVde8bCsvc7vO7HZnGnlITl7mkR2n+GGNlylec5kxCx91vr1m/Ajzj7RS4VnZQrQy7fOLZKq1Lc1n3aEDqKLenzvgdWq1MsU8T0v6RvaxTY0XknRL+oKk+yV9UJmCoS5Jl2VfozAFk+12ZeZaOV3KzEdUUVSktk6Zn/2nJX1emd8FGzSx3wW3q/R3wbXK/K5ZOuGAAQCYYtziEwAAAAAAADNYWlJcks3earK4SGswu49VwFl5Jq1oe0iXXDD7tkcePBiKDz39lTXnn6Izz1qmgeH9uv/XT2n3fv3v7nadYkd1YzDqyU8l1NXdqpZQfMWJixZqdNMBDW6Rrjh5tUb3HVJHW0Q2LPm+VXw0rmCoRSbQomAgpWDQKdrilOgf0cq5S/Tspu0aeOBJnXR8S9dzSxJdseF+DSip+fPn6dkXd2jfPt21c49eeuDhF6+45KITdc6as7V7/wH95Ccb9Jsn9HtrL1l+m5Wvnq4eHR4Y0chQv6yx8o0nZW+haU3RLTulvJXNMl/zC7Yyr43nrPHCkML25Tgjpb3MLfv8su2rq7SSUpkjLd++TDySZF3m1qO1OFNYEFf8+kxbRc3Lu95Zmu/x7ZXinmnHc7Qh//Wr9vvGKSjfReW7CpcpTOlvhXK3EfYq3B/YGpUUNRfEU6b/8oFW+C10DLYvyH+2vVdhkaCx/Oe1P5by77t2ucwKSd8os7lL44Uk/XVE0Z3d/8wq+9yizG0XgclwizLFj9VcpkzR1fopjuWo5JyTMWO/9G5W+d8FxyuzCto6Tc7vgi5l3rub6wwTAIAjigI1AAAAAAAAzExOkonrYx+5TsbEMq+ZtKR09qsUslanr1iq1nBYHdGU/usn93XZhE5si6j1Pded9tWvfv35H+zatekvQ12ta3f0je5IxPWVN779hIeefGjL1fF4XNG5neobGVQo2qreBdKJy5Zo9xPbFYhJ6ZEhufCQ2sJR+V5YriUqG+lSIBhUfGhQZnhA4cSI0sm4XDKhcMqoy5N2btmlxRfN05yWnZrX0aOWcJ8O7t+nZNrKBHXiO95++tfv/tlzV72y6fnfa4tq8cFDemDXbv3vN72lp//+X29eG4lqNJ186ZULLjxxINI+Sz3z5qi9d44GBg/J2rSiLdFsfjIXzTc+/6I8l39rz8KL6bkt9d9Kr3z7YsWv+mPNJnbThnJFDsbVKH7IKi6Cyd/mufJFLfXEYU3muBopKCqOt1L8+WPkf53IGI1ub2b8iR5fpeeT1X/uK/kv33+l55PVf7n81/rZc7ZTd921WTbvl0lxfJXvkDZmqefGVovpl7TBOcn3s8WlLtOH9Wv0NXZL45rj0b5C02INdXWUHn+0rfI2J11nXfAb1uX/tbT54+RWoLp5rNit8m20b5d0Zo2/5NdKmaIYa62cc2ppaZW1dux5PYwx8jxPnufJGDP2PK/QphHr8r7P3YZwTCwWm0ifVU1y/FVNRfxHUjQarbSpW9LH67yt+3UaK1CzhfMvEm54/h3t8udfIBDI/t0xNxtjSovTcvk19kxl8n1L9d5tPYWqUrZQ1ZhAQ7GXmuqbsOX6t0XPJ7v/6Wpfb/8c/9SMx/FPb/t6++f4p2a8mX38FKgBAAAAAABg5sndztOkFTD9Cnh9mcIHY5UpULMyTgoYq2jrHD20fv2bezv1kYvXaN1x81q7Z3d0af+uV+ML5+pPj1+64pOpSKc65vvyTULBsNO843TW/AWzNTS8V7FEUsFgQqNWSiilhIsrkZKibVEN9PUrmkpKrWHZaKsUbpFvrVJDQ0r1H5aJjUiptLxEUvN6erRx+2uaNW+OTMBTOCjZWEqJVEztPe2aY9vU0bnvrPa243TdNaf83Ldbfh6NJnW4/6D27dvzsVSi7+/f/945kf2HDiidUv/zz72yfv9hfenUC06+xwZ8dbZF5fu+5FtZZyTZsdtq2uztN6XxgpDcc7/gBKMd26feldSs88aLTiqsGOPyC7kmcA0y139xMUxuBbNqRTKuQoFPwXNTuY/iXOQfocveHtRv4Lp28TDFcRWvruUq7FdNtXg8V7i9eNdmx691fFO9f634yf/U7t9I/q2RgrZ8kVrmZzuotM0Uqo2tYOgV/o6xLl0p1NWSviDnFa3w4/3KOXedle131mWKJZyTdX5RgUSFQp+av7+KLyjRXlIDBV4zNP4Jtk+5SFF/Y39vuyXdVkeBzweVWe1oW5V9blHtlaxy1mlmrGZ1i6SPK1OElzOQfe22aYgHjVmnwveuGm4tW0F2BbWlqu9WqB9X5uemmltUuzhNqv+9AwDgiJvq8j8AAAAAAACgCWkFzLACXr+Cpl8RO6hWP6m2lFVbKq12/7CefWz95y67UHd/6Oae695+w6LuNWd3a3bPkC5e2xu57vrQFzdtefWL4XBCbtQq6lr167tfauuIaK1zwwqYlLqiEQVNWH0xafPAfi2/9BQluqTNO3arrbVXo6Nxjfb3a+jAbo327VRqYI/8kcNy8YS8lFUwFlM4ldTwyKDa5kgLVy3Tjv49OnhY8m1agYCRXFqdHRGtWK7LfvHzn0dbWlrU2bZIsVhKTz+954vXXKMvvvUtyyInnxDUuatDuvSitu7f+UDndddf7d39yoaXPheJD8sMDKvTD6g1bdXm+2pLO0WckyfJGU/VTvVZZYrYbHa/3P7WlHto7DHWPrdN449cPy67LVcsV8orelSI0ZQ+am0rV5xWT9tyfaS9zMOZ8Uf+qlDFDwC1WVP4M5V75LaVsU6ZApZtGi9V3pZ9rTu7T24VmXJFO5eJAhhMv+tUf5HIuirbMitZ1W9bA/s2KhfLeo3/bLrs8/xbi94i6a9UevxdytzicN0UxojJQdHZJHHO1fu7oEvVfzaWSvrvkxASAADTigI1AAAAAAAAzGBWNrtqmmdGZExSnm8VTksRP62IS3726jdFP3HZ+bPVFXFKxwaUjg8pkRiRr306bnmL5s/Xx37xsxdWRIPS/I42KaG/uui8jtZ0alAyVh3RTiVTQW3dpR888eLWrVoU1bI10ua+Q9qyd5uGhgaVjA0rMBqTGRxWYGRUoVRCAWczxUqmRTZk9MKuzZpzckA6aZE27kxt3bxTP/BaAmrr6tbQyIicTeqUE4+LjAzpllSqT6OJlO65e9OKFSfpY+ec26NEcq8O9+1RfCglZxMKBmM6/+wT9M5rl39ix0sbP9sVCMmMpBRJW4X9tMI2rZA/vjqRlQpWUhvPYOYUoDXZQrUGbimYKS7JP4U4/n29K7A1w5rK41QqTivZL/sot61cLsq9dgQOFTimVClOu1+ZVaWOz3v9+Oxrt2eff0HVL/hfq4kUwTRTeJr7RdMMxj96xy+91HZdub0qWFplWyOFbs9oagvUbpf0eZUWhl4m6cfK/MwtVaY4rZp6VpMCjnrZVTsb+V2wrsq2mxvo544G9gUA4IiiQA0AAAAAAAAzj8k+5MkpLN+E5XuSM1ae8+RJ6ttzeMHS+dE/Xr3qeLUooEPbw/rRt4cSG54aTi5atkjDNq1oT6vmzJWU1PG9rVZf/z8PnnnRWfqT43ojirZKiYTku5Cee2GfUlaf2LBx5F8P9O3Qe//sDRqMSNtHXtXQ6EEpndbooVEFY55Gdg3IjBgpldSB/gH1m4h+s2e74vOka/7mRvXv3a6HntVXD8b1iQ0vbVPK8+QFA/IU1ykrenXJWv3J3//Dz8703ZCcpyULjwuota1d8dSo5s2frVc2KXnXT9KJkZEWHeo7pCULO7XyhK4/fubxFxd0hKIKOzf2CFa4ol5jhaKCIqxaK4xZVV8BqXjFstqKV1TLrMDmVLhCm1X+7UtLHyraxyrTR/EjN0a1/sdWf3OFrxVsKxN3XQ9X4zHRfmfK+DO9f/I/ff3n/TyV+9nL/HwWKF0pqnC8y+S8j8t5HyzZr1Qjq041X9zULMY/OscvWDm0YD53l9m7zn4KNFLcsr6hMRuzVLVvM3qbat+iUMrcopAVunCsWFpzj8o///nWNTDm+gb2nQFy/244VnH8HD/Hf+w6No//2DtiAAAAAAAAHEXCSqhTSXUqZVqVNkGlXSBT5ODpNJm4rB/T4FCfOjt6tHOP0q9ukzk4EFaofZkSdo527FDfNW/tufdH339h5RXr9OBVb1iigB3V0OGUFJD6Bq32H9Lui9au2rVzrz73zf94fFSzO/Sp/7hJsZ5RPXtotx55ZaMOpQ5px8HdGvRHtXtkt7YOv6LtZrt+vn2DAqdJH/3WNVJHTF/97iPx1/bp8+ddrl3PvqTdQwkpFGlVOjWsvkMv6eqrV+rGd+vB7/7nAyuvvO6M+3bu9vsGBtvU27NcwdAC7dwh8/QGpYdiCQVbA7IaUDiSlJFOkyQZK5l0zcxVK04ruMVl0aNcHzbvUbLNVF6hrFElq79VG1/jx5FfNFfcvtztPEv6r7GCGoDGuSrFqxVer6eo5/N1Dt9YgRAwMzUyj2+vvcuELa1jn9xKh/Xg53Nm2zDdAaDE0gb2ncrfBQAANCU43QEAAAAAAACgmvySnGPss4ZGsgoroblKylPaWFkvLutFFFBKfkjJVNAqaVOKJ1NqnT2secvV9vJWjT7+7OjBhDOjGzZsfX7bq/rXkZP7fv8Nl+tLV1x2nBcKjKh/YFg9c4x89ejRpwb19Eb9wTkXenrTpSfGH7jnlTd9y7vjoQ+89y16/9feoJf/60m98OCgNr58SPE+qaVFSgQk1y15x0nn3ixd8q43SR0pfe3Ld+nJF/TGs8+bG2/pmK1Xf7PxD556ZsdPLj53jgJeSqMjUjL6kq69YXF7sHfH8z+779mP7N+im7e/8uLvnn1e72ktkaHWnQfVffoatXUt7NG+/v2aOzusVGhUaU+plOcp7Tk54yTnZM14lUduduRu6ZmrNisuBPEUGH/NWBmNzzKvaAUHz0nWuMLnef1bkx1nEoq5rMn0n19EZlxh/JnxC1Urgmm0//x98/uvtA1AbdV+Zpwp/ZmeEGOzK9BYZUtm+2WcjJE852Rt7vXpNilHe9SMb7J/o7K3ujvi45c6YuP3H6mBsgZ0dK2aVFd+SudPY4wxY33UYalKi4A26Mi/lzNBIwVq26YqiNeJbSq8ZXWtfZv12iT1AwDAlKBADQAAAAAAYFrlrws1A5f4962USma+5l8fNKocqvUkz0qBtBSUfM9TQp78vOMLSArKyspTUkGl8zrzstsDspKCipkeecaT5+LyXb8kXzJp+UbP+kY2JeMpIsXNoC67Yo76f3Jg9K579mxLWw13dCh52Tp9+qxT569aMi+trl7pwM5DikYj6uqcqyef2qUnHvS/fPmFZ/708EhcRtKVb1nx8PNPvrrmtn/9xXffc+0Zy0/6w3fqpLenFd+wT4d39yuRSMi1JjVvRauiZ8yR2mI6dHifvvXF517d+Iree+m6FU8cHvIU6w/qrFMX/fT+9Tu/smRJ+vcWz5ulUPqwfGOV9vfoLW85yTvvnPCtT/5q2wvPPTn84n3rD232rdoXLtLJZ5+3tNUER9TR3SpfYfkKWOv5z1ovrbSklBdW3PQobrp0ODgs3wTle2lJVtaz8pxknCfPSQGXmWO+l85s8/KKrlxKLTap1pTUlgiqJR2UMaHMJueUV5smY/3MVyd52TlbrZBrokyZ69BemdeskZJeUAOhkOLB8fljsxeyPWNklFbIxRRQupGL1GPjTVYxWrn4i/svLpybTEd6/OnMX73zp1L7Sn00g/yXj8d3EzrWZ5RZHeavSraMFalpQNlbDTbyc4/J12yB0VFsvaRr69x3W5Vtt6n2rTWlqV/xqt4irU8oc3vdagU539TMWKHrOmVum7hOmduOVjKgzO+c23R0FQE2Y5ukX6m+ubdtSiM5+m1QfXmUav8uKP27V2p9nWMBADAtzDH4PwYAADSto6Oj6vahoaEjFAkANIbfXwAwE6V1/Y1vyXzrIpINK38tLBkr12SVQTPnf3rjcc1/bbvmjMYVyHbjjJTypGRASnmeZvXOlifJOCvPeQrYoFKBtAajg9rbbnXg+LnaF40o7oXlFFRvV69ihw5pfiik/tGUfvbA42vVPee3FQydKRPwdOjwSxoe/u6KU5bfHnIBdXUtVtjGNcvfoe70XnW4vWpxSflWCob1nZve3/buto4RBUxY1nhqb+vUjl37FQ61av78hQqFAvL9Ibn4PrmUVdiFFfRmaeuWQf34h6M/WnXiCTf6rlOjobRSASunlIzS2vb81mDA6lNnrGr/wBlnnDC/tyvQ1tkZ8GTSCkbbNDSYtFt37x15fOOOvS9t1rdGRvSZhUtb035LlwLpiDoSYQWs1VlrV+pn9/70h9det+jtCxcaxWM7ZAJSOBhWtLVHxrUrlZBG43FZ+fICklNK1o7KN+0aGOrSj37w8ncj0nsCwTbFTFyDwR7tC56kQbNYO/cm1D8aUyI0rL5Xnr5e83reJeudHEyHbYuvZ0a2bfnGZVdc/ICNxpUKJpVKJ+WMle9ZtaRj6k0MatGg1YqD7Zo1EpU1UWXWWTMysuo70KfMumlWAZv96nK3GLU6cHA4OzHqK4gpLnZppECluAjuQGtA6bPO1YHWyPg+efM9rEGdsiDztVhBcU3RtlqHUU/BTjMq9V/LkRx/JuevWeR/ahQPm1CPbv3Wk0rZztzP9s2SvlEQkyu4nfGAMsUkG5S5CH+ZTMmKWM9k+9kgKbtymuR5uZUfs1+z7WIj8RpR1yoan+oVuY6+8Y0neZ6RZzxZZ+UZT8FQMFOsVpT/oudL5bylyhRpbKtn/FhsuJ6DaEL18aPRSKVNSyVtrXOQy1W9qOQLkv57jT7+X2WLMl12xUDn3Nj3uef1MMbI8zx5nje2Aln2+22qXXh2s6TVkp6usM8/KVPAVlF+/Ol0euy1cvFHo9Gqx2KtLV5FbWl2/JsldVVtXN4nlHk/JEmxWGwCXcwcNfK3TtL9dXQzNvek5uff0a7Mz89qz/OerrNYutbvgttU+za6Y3N0ZGSknjEBADiiWEENAAAAAABgWlnJZC/Au+m+9VWpFt9qdjyuhSMxhbLhpbPFafFgpkCtNxZT5iKulXGegn5YiVBSgcCwRlqTGlBQQROVvE6lTFR7h/sVbQmrL5nQ3Y8/+qnomrM+7WbNViDUIqXSih8aWB1JpN/16m+e+vqi5af+TsQLKmAj8m2vfJuUb/qVVlJGRs66Tz72+Mh1V71tUSSdTCgUsPJdQgsXtkk2rWRqt0YTIQWMUYvXpZZIi0aGnDa9sE8P/Uqfe/uNl/3RixsOyCkoK8l3KfkKKOgFtOD4RemWQPqvdwzt/evvf/HZvz15tf6fVavV1tMTVjph9dKG9Ojjj+lfLr5Yf7FoidHgSJuC4R4ZYxVwVgErSUEpMEsXXPrGG7/1nXv/cc0afXLtRQsVCSUUUFKjQ32S+uRMSHJBeZLCASkUiiid6tBQrF3r73s5fviAPrmw21PA8+R77Uq4Ho1qnka8uRowwxpt61L/zg1f0+qLP9SxsFfGeQqlI4qkdfZIsPO3f/Xczj9ffdHKz3hBXwk7Ik9pSUkZSUE3omjKak4srNnDUaW9NlkFFZCTJyszHFfQWRmXKUwLKq2ADcpkV/8LDmTmRb0rqBUXpDVa/pA/jvUjOpjskAu1j7+WfxHUOQX9UYXLXBfN9ZMrynGmTGxl2tUqqGvklqAT6b+WRm9JOtGCweL8TWb/zeawmbbkf+rzPxZ7afvblCkeKbeaUX5xmrLf36zCW/KtV9HFfVZQm16e8ep5D65TpqAiv/jpNWXmwu1TFNpU26b6V6Cq5ePKzPNqK7IdidtQ3qzKBUu54jQp8zO6LO+5lInvdjW42pYxpqnCpqLCtFtUu7inls9rvED29W69pDtUeyXA7qkP5ai2QZnfZ/Xe5rOajytTAFptxb+ZsDohAAAVUaAGAAAAAAAwU5WuDDPjeE6ZwjUnpQKS72W+97PXBCN+UnMS/ZJJatCLKuaFlAx0K9AS1c/v+s914aWLPz1ryXIdsGmNpuLyQpJpjyrQGlTbKed/aOeG55+af/GiLwWcVVKdGvGspLiiiihskgqk+/c8/ZhOGezb+ejKU8PzrUtqydIezZ7bJS+Q1FD/oHp7j9ehvaPa+No+Hdo/mN600X9qZESfes97Ll/fHzcabJFSXlqJgCdnAnI2JZse0ew5QVk3oEMDuvUTn1n1Lj+6sO21fcPaMjiiLnz3YQAAIABJREFUWW0hXfA2r+3qd4Q+fPt3Hu4JhdwfBI2ngALyfMk5KR5Ky8nTUDqhYEuXrnrrJX/0lVsf/K9NG3f/7YnLde5JywLBzmhQvbO6FTJBBULtCniennvhRQWDAzqwX3p5s/a+tEPnB6U9oVS75FqVCLYp6WYpmA4qEkgqNbRP/bs3/2Hrhad8qGvJbO0d6ZdMUAql5aU9dZ1zpgZe2fzpDb964dE1F124vtWPqsXF1eoPqz0dV6fvqT1tFPWNws7IN0bWM7KeFHBGzhTd3tVlihGzMyDv9QpFCJN9v8QyClaTyq9Pa6A2JRdmMyu8Fe9fbvxm+2/URFcDa7T/3HvQ6HjFBYpWpTls5hhqtc2NNVm3qG10/Mnq/2jJv80vBM0rDs2zWplCkpuVKXzIFYPcptLiltvyei47/nh9ipPkHRV/V19PilavKpf/dZJ+XKbp8cq8v0t1ZIqvpsItqm8FqnrcLOlwle1HoihlvaSzlDmua5VZrTD/5zPfNuWtqjVRnuc1tfpWdu7dokxhz0RWTCvn4zo2CtSk8dUoqxVXrT4yoRzVblHR6qAT1K/Me1JphUIAAGY8CtQAAAAAAADQEOv7UiAw/jxvJZ/cJUTPScY6Ba1VRzIp30hR9StmgoqFgxpOpqVQ8MMds+bIGU/JRFySr0hbu+QHlDg0IuunpWjLRz0T+1IoYBX0jTwnWevJea1KuoA8E1f3rPg7lyyORiUr35cee6TPecG+nc7o+WRSswYOPHdGMKBIS1heKCB74opoZzJpP/6jH9z/gcGEfrJqzaLbk15EKROVnKeQ8TQyPKSukK/9QyMPXP3frr3k3mc3644HH9KL22IKegEl+32dd4L0jjee0X3DTW/5/e/c9otV6fTQWj8VUltrq3xn5QeScp6Vn9qv//rP+68PBHX1Gy5VT9Coa2C/7PpXfC2Y49v4yL54OKRnI2EdDrfoNF9atHiJzJweo3jcRQ+P6J1dnXP/YWTvoDy1yjop4DuFjK9gMKHZPa06MBj+w/ZoVHv3HpBaA5KXlmwmVwOHBxXo7JKfCn94frhzfaL/NbXaYUX9uCLppCImrRbfKuhLQV/6v+y9eZwcR333/67qY869L63OlSVL8in5kO9jjQ8sg0GAITaQIIcAubBNAiHJE34RgfAkIQfwJCEJIcgkQEgM2BgMBmyvjQ9s+ZJtWYd1rKTVsau9Znbu7q76/dGzq9FqZ3f20mH1+6V5aae765jq6prp6k99vob0BYa+P9oY519rjNIwtMDEQQVnD601Ws2MCmimxURCF70Fj2PzCD11sdVkxHLTKedkZSbEgkH7j4+sLBTweiYtbikVzpZDMbFnY8BxZv3IX/qYc1ODL8b40ugdpwgdVOaiVokD1SCVuVnNNi/jO96dCrThu7aN5zY1FdpnOL+TmWFB1EwJLU9XNuCPdTPhovYyvjh0pvt1QEBAQEDAcSEQqAUEBAQEBAQEBAQEBAQEBAScdJzcD9A9z0NKi3DYJi8FRjxKtuAgFETNELJgoi1BwvEISRstw9RIRaPbRybfz0A6QkvrUkjs65fuQg5s3YpobEDaIVQyT677MHEtsY0smSrHqqnOY2VS1BQg5qWQboJQWDCEwf7DueW3v6P2b973/ivpObSdcChKV2dC/Oc3Ox/es4cvnH0O/3TOCmTrXMSi+fMxDMPGk2cJHTorf7WiP+Pd+dPndz6zZQ8fOW/Vss2oKNoRSEPy/IvJT9zz2fdc9Tf3v8HXH9lG84pLiK9eiGXESHX38FTnGzzzlVe4Z+0Q777jnVd9/Z8e+ERzffIfLDMEOo/nDrKn0zvXG+r5t/e9LX75kjOrMUSSiOFgGyFyKUHX3oTY34V8fTMD27fxewvO4E/f/+HYbzW1RMgkw6y+7Mxq7/7Hvvjkr3oebGiwtg2mE4Rl3hefUUtehrG0BsOy+g8MEm6oxnNMovEIyskx1NeH4YKdccjmsv0yeYglsgtSe9EiRF1NnL5DSXTWwlIQsWwG01mIRFF5h1hVlKQGwzBRbsE/98IXhflWZYIj4rSx+u3suxVprcu6q2j0MfvLhZsbFqcdIxIa5fgz+ZCGk7uep3v1j+WANR6TDbk6upypiKTGK6N0XyW9Z8KQq1KNf5wo+W+abmFQdAgrLX8y7T+J8ofLOSb/Cs7HeGUc1f6ll3cZKg15W+pUN1yGrCisdbneUkw7LGoSI+KzVfgCmvZRCV7GFzp1Tq28So+f7pj3JihfC/+8iKKlanlWMSzeGhGnHVP+BOKtk+3zj0bdw8RuR6uoLJTpy5x4gdp0qOXItdlWsn04/OeGGSxrbTG/mXJNK2U28jyZ6cAP4VouPGrbcavJqc06Zk7oNxvCy4CAgICAgONCIFALCAgICAgICAgICAgICAgIONWRRxQEY4kFphoaaSR7aVL6ENYwLAwzRNbTpDIpug4eMguZwtLGqqrcwtYFnWEZI63z5CKQJI9QEunlickC8TBElOC1zW+EWy22uYdepH7hKvLpOCorcDJZmgyLsDdEfmgnanDvV2RWE1VQa0aIeg5aZ9CeiyVtamvJel6Onzz0Y71rF9z69lZhWzXUxLntppv44C23zAlXV0UoZDNkskkKBY+WpmYGersxQ5qFTXXcNnfx5fc9uPvlZx7bftM1V5//mOcJujoHxbXXRu56fvM2vvfYXqrOvIVcdR19Qx6xmI0KtyBbq4nHG/naD37JsgXzuOKyOXc98bNDX1p+Xk5rFLvf8N6ycgU/u/baFqOuXlNdm8YrpAgBuC6mHWfBnEZxzoozwpdcItY8+MNnN3f3k4tFq+jv6+cnP+rVDc1dxKJShG2V9YRHXWM9TjaFJItmEAzo6tsLA3u+IuzMV2qrzmQwpcglknhOAZEeJKYKyIFD4B3YavVnw9XhvpypIG8MUcgMUVcTIWaEsdM2liOImTahcIxfbvxlm0CHw1Z4R111lVtTHaeQdkCXhvdUSOGLEcZ2RTLQ2pvVOJZaq4oEaKMZFleVinWOd7jN4xD99LhRibBq2FGu4jwBNQNOYW+mdi5HJe0q9OQEeFL7cp+ZbP9Zdn7bQHkRxbX4AoF7mFkhTEAZlFIYxrgnuxLnsFOdl4EvA3fPQF4dwJ9XerAQAs/zplyYf/6MiQ+sjFX49S8n7non/vW5lmJIVyHEVH+/3gP8w1QSBpRlPeXH1jFdwabb/051lFKY5lGP4DuY2AWxndMnfGxAQEBAwGnKyb0cNyAgICAgICAgICAgICAgICCgLFr4LyVk8XX0g3+pJfLYkFmTRCKlDdr0HU60JGRH6Osb4MCBQ9FcMvPlcxae2XnDxZdvuWjhmbuNweym3Vu332XGowzWmAxUgSOz7O1KRLfuzb4v6WX/tbEp88Idt9Tt+bc/nP+5m+dmcbdvJP36NvSufuoSAnHgMInNz2P07N16bjPfWhDaSZOxE9vdh1B9GCKFVENUyz7aGtj7q47cmvu+y45589GGFaHjia3UNFL7ntuWh9PZXvqHush6KYxQFDtSx77uQeyaGLEWk5zXSUTt5ndvP8u88mwe3frcK8stzyQ5QMv8+QvbdnYeQkTmYERa0K5LfZWJl+tB6QG8iItTXctBZfPEq91UV+m2sEmLJ7JsfGFwxRXn8shvvONMI1KVxTFT5DwHK1zDvkOQd22UtHGUw1BmP8nsdm69bVlk+TnU/fLxQzTUnceZZ0r91JPseOxRtcaW7I2KKJlkgrwu4OhBTLWLau9FFhtbOC+e+VZV35at3c8/RGhwP/QP4PaliOXzuLte5Nr5PXznc+d+/o6rUnvmV/NCdYx/dbK8b3AwH8mLAp5lkHcKpJJDHO46cFehP7nplouv3X3luRdtWTR3bmcikfjy9t3bY0qNci1CIjAQQiCEMcbr5IlBqIXyXZaEQqKQWiK0RGgQqBERjRz90ke/JmKsY0vfC33kNVZ5M01peWO9Zir/cuVNxOj2Hav9plP/kXYep5yZDu06uvyg/ce/BmaIVZQXUAxTA3yDUydE4SnLdIXxJXTOVEYnkPVAYpz9bTNQxlF5lH73TuVczOD5G2Y9EzuPXUtRnDON3w4bmLw4LYEvHNo01UJPAzrxw9WWY1Xpm+n2v1OdcRZN3DNDRXTMUD4BAQEBAQHHncBBLSAgICAgYGZow1/hN3iC6xEQEBAwEbXFV+cJrkdAQEDAaYQLOlP8v0R+IlxgWCxTQGH64jKpQLvFgyQghUZooUGKgr+5mI8nQCERojjFIxRag6EUAkbEaUqPFXawHKPDYymEYeEJE8/w9ykF/dmh2qbmORuvvurqpXMbmjCVQqdTZBLp8/cd7P3yo6+/eKm32vjA4YEh2xP8xSWXGeuWLWtuiYQKNNeF8DIpWmpDXHPpjZz5ky5++twhBgYOYeQFc+pMVt40h7OWzJlTZSVe27eze1+qn32JvsQbAwMMzJ/DQDoDUYuGplqWnbGQJeecO2fh8nMWy527djKYgmuubmIg1U11rY1paoaSeQ73FUglPBYuXEQynSIqEjQ0WDj9BXL9u3nvrav53x++/DOhE4tiUVKDg/1Ku45M9fZh1g2QN3Ok04pwNEIhU6CQzFJIDRALhQlZBmE7pD2HVDabZdW5PHzTdUuw5RA6nyTeEEE5mh17E9RW1/HK1gFCZDlzSRNm2KXWdLGjSS64qJ6f/6yfrn1D3HjTrdIKP7Vwx+7eP0kmub3/cGqr59Ln2qCEU2fqbJ0BZ779IhaE6+sWuNGFkee29bHxjc30DHoYoTiN4QK33rGY911zBk16b1y3xuLOWfXN6ay8cG9v6qNdfenuja+4GwZ6ez+TSFU5zmD42yvPOeeO8y+4kL5EkoLrkPOceW3zF9y1dfNrtxzsPXjxgubWRN48IobM2/KoflmKI02GhIkjy0uvJgzQJkpEcUL5QjN8sWRvOErOkFCMdugf7xb3m6BNv+8KWQwnqJBa+NdGUTCjxo1CN71wccMOVKcLYwmOpiNCkhoQlbfhiQkye/IwK+1P5d8fYwn9xksrcQkrECJZ9pjxtA0KcIWN6z/mmIzobANH5nECZgk/vPK4YqMOfHFQOeFSgspCX57sDOKHly3nftY2iXzKcUwe03AgA46Ez54hoXmloUlX4ovZ1vvC90mVvYGJRaqj+Sz+uRlu23b8PjeemG48seGbmfsZDsl7LG34boEjTLf/neqUuXY6GT9c6qoy2wMCAgICAt40iNP5B0JAwOlOLBYba/MqxrFX11p3KKVGblCVUgy/P9mIRqNjbW4/ztUYzcuMP5lQyzg3IlrrTqVUZyXtX/L5x82zSMfoDZlM5piDhBBIKZFSMjxJMPz3KNonW14l5U+XSdR/MqzFt6B/J3Adxc823fpHo9E2xp+gGrcvzUb7TYaS/tc+waEdY208Tue/TUrZNs75n+h6HYs2xj9vg4yasBlF+yTLm2k6mQHR0jTHj+NNG2Ofs6mcf2BGrv9ppR+H0vHqs/iTvrNJW/FV+j3UMer/SZNOp6dRpYCAgIAThE7y13/4fmydOuJCJlyQOZAZCiKM2XwWGVWDHWnkcN8gjpvllRc3n1VTNW9lOpH//tq1txWiYQNTD+K6OQwdwlWSpJNG2CF+/shjAEVHKDC1i6HViGBo7sJWoLxQY8+ePcW/ig5TKP87W2paMw4r9g2wQJu4JiA1QsPeN9742rWXXP5bi+fORwhByBQ47iDpw/1EchF+tf9lHjP3/r/zf632rZdff8YyzF5sI4Mps0QFmAhC2sYjTKihjcODGfZ39zEw0McZi+cSCWvCYQe3kMPJGDiOpJCHXLbAYOIwti0JhS0MW1BVF6F13jJe35LkwR9tob6B1A3Xz4vXRlNolUAryOUsdu1y+OEDJK+4gsj1bznXEt5WQoZLVJr0D3o44bl09Qo2/GfXZ37jA6s/v2Pbxk0Lzr3i/Pf+6dMUWi/EWriQXkcRrW4kO5ClxrPw9jzH/PxWvvN3d/DLB7/zykXnt638+aOdf3bzjQ2fW9hsIrw+GpfVMdh1GA2EovN46Mn9zkM/JvOHH43XNNWBq1PUNoRJpAso3ciD9/ekDnUT/+jHVlPfGOFw/26UKtDX00eh4OIgiEYiVMXixMMWUdPDtExkKI6wquhNZkkkMygkddVh5tRIRC6Jl8mgHReNBFPgGQUcKTnUk2dnR2b7tg08fH7dio9fd/Vl9KYSpKwwNdVNJPccQqezdO/fz+6uzq/VLGz+aMaErK1QAg7t6jrabUkcCQmWsG3qLr+cpB2Z8FJRwk+rBWjl/160LIMLL1zh/8ZSNuGIjUuOdDZHyKojXN3Alp4unnv1VTuXyb07n89uuurqi7doLQhbzeSTB6kz9xAWhzDIYegCJr5ATSgbtGTz1lcAVV5II4/eIScheVJT8EQbLfKpXFxapg4TpJ+ue9jo/Ct1mZtM/uOKnPTYf5emP5EE7T9O3ph4hNHYZY5TvsK6DAVRzXcf3kpORMEXmRwbRlGMul6PCGk/C6w/0fMnb1aG7/WFECiljrn3H34fDofb8YVFi0ZlsQdYm81mx5tDOSnnpEsZNT/bydjCpwSVhzst94GPuscfnjsuFAojf0+G0edvqpR8/slUIKG1bgMGtdbIcQTuJWxgcuK0x/HnRzrH2LcKX4w1uk8O82WKTlhvlvFjnOuzdHM78FiZLGa0/53qDM972rbNGELLNmB3maSPU9nccDvlz8Un8L8Pg/mzgICAgICTksBBLSAgYDRfovxKGPBXJJ/KrGf8zzebJJh4Rdwqyt9cwNQEBRPlCTN7XtsqKO9dnNorINvwJyLWMbE9/VRZR/mVlVAihjvJOZ59b7KsY+bbeKI8J5pomKi9ZpvxxpgOZv/7YbwyZrLPr8MXa7Uz/jW8p1jmhhks+3jThv9511F+cnUmaS+W1V6mvNLrYxN+295P4OYWEBDwpsfF1kmiKgnaLm4rgMqBSICoI5eX5FWIdHqIiBnmUNe+v1q6dOmnt23ff7vwpKPJkhrKYJg5TAk5x0MYJpFomGQ2jSE8fO8gjQFIXQy3WCxNTspB7Wi0AG0aOErhGCCkwETT0tT0tpaqWtxkGtu2IQTSyWI6LqkDh9GJBGddyMevv3oFKtSDsgaxZBobDwMwNKBMLJ2BwX6aTEnTGTYIEwp7yOQdcgkwBFhGHdoMIassHMekobER0zSJRCKYIZuCcnlu4+s88cuhjt27+aN5bfwYy4wfHkiwZGGcwYEUnqeYv2guN97Sz4MP5HbNad675LzlYdN1U1ATIRRJU5CHqa6LsvJ8Pmeamc8//DC//4erQ0/802fez11/9W2GcntpaF3MUOIgtaZNctcuGgsH+dwfXUuhfzcbn+P3rljdxJKFnZ9rrNVYtufbc2VyhIFsAV56Y7/7y6fYffOt9XMaWuqprUqRddLkCjnsUIxQaA7NczKZx3+Zuu6+723826vbl15b1+TQ3BQiFqkhFo2SSBTNO0QG6XnoggYHLDWApSwWxAQLwg6gwJLgFkBppBFCaRONg5IFpMgjBTRUw1nvu2KZvWnHMva4qNwQMe3iaoXOpFHJIYy8h+G6GIi3q2K/QPthZR1TlLg0SWTJg7iMbeFEY/Qd/ZBzTBQSrRVCmAhD4ilFvpCmqSpMPqRB2YRCEVwdxqoPsedwipaQyUAhRSY96ITsKt3c3Pj6008/9TeXX3bNpz1PYhqho0pAKNACoaUvphkVytC/To5+GC+1MeXrR6JKBTEnXCx1MjBb4TRH51saQjVo9yOcTO1vahcL3z2tbLW0N365FdfwGNYx+4t2TnuGxU2jBSol7zvw71vX499HdnLkPvzNxCD+ve9YIqpZmVucCQer6YjTpkEN/pzNhgrFaeuZnDhtovn1l/H75Fr8efX24vYO/P65YRJlnRKMc32WMqkFt4GDWln3wU78+eGx5j8rfW7VMc6+SsWuAQEBAQEBJ4RAoBYQEHC6sZ4TJwAptQt/M9NewTFrOfUEarUccR86USLHgICAqVOLLyy9h8onfxfhT3J+CF+sdg+nzti1juM7Xq3F/45dOYk0K4F/KL7uLabvnOF6BQQEBJwSaB3G8+aAnsuTP/vekne+7ebvf/i2j53/1W/8y+evuOrC77reEOid2CETJauRkThf+srfNdbV1t60fOnycxrrmxYa2m0F/hJ4TCKRmAglj3WOmRBZVAlIEAK0QKHxbPAKBQwkhhJEMMgUnCF3KNWqHQ9HGsiQxPSShBJZvIKJKuSZtzhMpKaAtjTatDCExMBDFqvlKRdPgfAsnIwmPzSEFgrbtjGsGBFb4CkD5dq4noFyTEwjRjxSRSKRZt++XgYSvWzfPrTthU3887tuu+4rZ51T4Je/eur5887Ta1ob6hhMDmDbfohHIwwNqVh1OpPb2XPYSWcWhWsaqsNg24SjBZLZPNXxEBde1MD3/2fz537/dy78zE9/8NjX3v2hd37kG59/C9/84a94o2sjXYegpRHOvRTe+9ZLWdpi8s1/evxrH3z/JU9+/3vPfe7Wt9dQXWsTshwiVhUojYuJMm16BjPpvEt6/oKGakIO/eleqmtNCkMOQteya2eSF15MPb/uQ9c/73ii/a++8Iu71tzK77bOYfmiBS04tRYhu9l34RMu2lN4WoAQGFLgugWkl8OwBAiPfDaDVmCaYIRNpJIoxwXPDyMrFGAAKo0R8jh8eD+Jfc3EDJsqmSVf6Ef3pnCkgas8tCmHpJaEXYg4vmixVxm4pdFrSxzUZAWOucMuYxIFAjwnS8QKky6k6Tt8oP3pZ574s4bmhoPJofTe7ds6Xzu0L/mzu+/+ZF91DNxCirmt1dRcfbFWTvS7u3d3nfvnf/b5P/v5z564+Xv3PfCe37j9xh1GLodBBkGhGObTwBeh+eUJLYvhStVISMljrozSZ6xTEDuVinWON7MlSKo0/4n2jxeCcjiM7HQ/QyXpZ0vEFrT/7LdBkQ1MbiHhIvz7xNNhru64M4XQkOtnqSonEx2UF1K1U9nCuD2MvRisvfRNqThoKiKhGQztOcyXGcvhsAxCiHat9YYKDl3L+AtFS0kUj++o8Pj7OXXmgI4H442VR0VvmW7/O9UpvX7KXEcdjB8utXMWqhUQEBAQEHBSEAjUAgICTjc6KL9CZTZJULRWPg1YO0PHnCyswhelrGX23NICAgJml7X4Dyumcw0vAn7A+GEgTjQnYrxqw2/b6X6vfogjIrfT5fsyICAgwHeKAgQuYYb4xSP3Lf2d33rvSx/49d+Ib/iXb3Zfd9kln+nL7kXLQcLuEDWxZnYdyvLYMw//zW//7kd/9y1vuT42v3Eer2/azFe2ffERhHoDXLS2MKhCYKCFoHxgT8qETSpu037tDAVxpYg7LgYCUxrYaPYd3PfFfZHo11pq6nFSGXQsjEGGTGqQPYcPkajOcdaSMPGGAtlMHim8Yc0bQvhR25SWaEJ4XhhXmXhCg5b09CRBG34oSm3TdeAwrgOFPKrg6ERiUO9PJtnT18cLgwmeePvbz3lk/sJqBpIurtDs7eLORx7du+X9ty2vC1tRTENSE7HoTSte23qg14rCGStW1GD2MphO01JrI0wDU0IhP0RDVRNz5vDJH/3oxc/ecNOVH/3Dex7o/L1PtH36Tz/8luq+RIZMLkc4LGioMejeuzf5x/c8+zf3/M7Zf/nj7z9nnbGQTy5e0kSu0ElNVbXfnHlFzhHIWAMLl8RrQs/1sHHjG71t7zynMV41n4KTRBgWuVwdj3W8NrD/AL8ZiraSGcxyx/tv+ArWjq889HDn9fFY9zVN9VwUjrAoGmZevIqaaMiUNbEGDMMgEtYYlsIOC6prIiAFyaE88bhJyDCJmhFAo7UDWvhCQQk1UQN3qIdll8TZ+XwfO7s3MzfUiuVGSAxm8IwIbtgiIxWuKb5oKrA9sBTkDYmlBZ440n9KH8aN94BbaYUUR/dBQyuUkyEiDBwnQ36wZ0eP7fDh3/7YB6+7+Fp27uviwe8/mn74+z/6pxtuXP1pVyRQXi9OOkN1ZBlLWud+5rWNL37ks//fH5+/oLH+pac7/veCi8/VO4RIFUUy0u9bQuJJX5xTKsKZDZFSqQCotLxKmZl6lZPGVSpiPTHphR524BpOf0LcfE5bjrT/ia5JRbyML9LZQOnCGT2uWHsVp65b9knP6ShMmYDxHKgq7YudVOiOPl0Hqxk+f/fgC5wqFZO1VSCQa6NyN7NN+ONDIEidHuWeq9QwSlgVOKiNK/LsoPy10EZlc44Jxp77WzXGtoCAgICAgJOGQKAWEBBwOrKe4++idrq4pwG8s4Jjhq3aT9ZVaLX4ApR7OD4h8QICAmaHWvzxdzKhHibiWvxJ5cmsup1Nht0d72Fy7mUzwUwI/0qpwXdTa8cfg0+X782AgIDTjOGH/NFwmFw+hxCS/btfvTwv37hseWv8k+96xx/EMffw/IsPPXpmWxuNZi9uvof5LXPxCoPsfOn17/7P1//rfdUNi4A8r7y0hT//1Gf+T2tL9AuSHMrI+Y5sbgzLDJF301gRX9gx0D9AQ3MT+XwewzAwDN/laqLwSSFP0Zz1WJByEEKipYdrwPIF8/69N9G9wnEyfzjHrEY5Hp2JXg45XfTXw1t+K8rSt81jMLcLS0sM7YJwcDWk85DNg2GECNn19CU9unvS7Hgjkc7n2dZziO0KulAcQnOw9zADQB9wSAv6bnvvlWlQeLqA8jSugoL2IGwhRJib1lze/ZMfPrO6d9+2b157ZfyKhvoImUKKjmcHdmTyrDXjVG3v3NLRvHphKJc2ObT/ELGoJGoJVFpT3xBl2VIr3NvjvINQ7fevuSH+hX/8186/ntfc+d3rrpbvaW1poauzl+8+5dzX3cXtH7vzas/JuGh4x8LFhD3VTSTmoYwMqaEcYcNCWDaDBclLm3vypsHvbn2doR8am+9fOK96aTTkkc3keOyzhjcrAAAgAElEQVSx7qeH0vz6O979lu7eoQGkZSMME8tqYs0t8UdMYT4ihEU0WsV/bXg0Zhg0VMXdOZbR3aA1dcKgVcOcSJz5sTjLFraZy6OxcKyuPsz8+Q2kEv2oQpLm6iiGdEGBocDUQDTFvMsF12p45OsJtuxLcGHjEgwvzJCbJy0KbB3Y//cN9Q3/HvUEYReUMFASDAyOfgYny/zt4ykP5SkM00CaFpFojHQyhdCKuqooBZFHpfqJ6SznLVnQdfbl195w929/4k83fH3DX154/mru+fiZsXVvu+WPPve531104QVzbt9z8Fmqw/WEcw3IQpT9r+58jMTu29/71oXxFx7d9Pim5xN/KzW/Ou/clmfqa+eQzwk8fNGK0KCEKjqrHev0NJYwZzzHKRhPgDa6LcYWzYzOX4vRYUgry+eocnWZ63yMkKbHpNZHpz+qTSpIX678I9lMnF4qOZJoYrFUuXYtEbmVCJYmEgxO1/WugtaZ1fxHt9dweSP9bKL2FEfXsWx55fIRo8obB8UY7SGPzrg0nyMOjSOpXsZ/OP8lRtyaVPn+HxBwfHmZ8qKStmnmPd30x4P1HHElm4n51i9R2XzEvfhzDAGzSxsn52LOk5GJwqV2VJjHWGLBIMRnQEBAQMBJTSBQCwgIOB3p4Pi6qJ1o97TjuWpmMs5o7Zx8ArW1xddMilkCTi+CSYCTh1r88X42RFs1+ELnO6l8te5M044/wXqixqt78MVks8E78c9dO4FILSAg4E2GEhTDZxYFJ4ak68CBO85e3vDthW3NYIb57tf/iNqGpVSLnYtDBRc7l2HXa88tHNjOX8tQ9IKLz7hoebXRA45m745DfPy3fu8r99x11xceun8DBhk8mUUBwrToHUhR2ximN3GYxtY5tLS0kC3k2bVrVywWi0Vra2sPx+PxCQVqAjC0i6VdpJYoIdAaIlGbjO1+8mCm7/7tPZ3vtWLMz9ksWXqJvfKGW+dSu9JgyN2DsAqYWvhCIMDzYGAAovE6Cm4Nz27s5NXXuHfXbv63sYFn3/+Bm3uHknm0svyX5/+vtEJrD1AUVAEhPbRyURTwhIMnwKOAhyRa1cJb11y5syGav/JXzz5/VnootdSBxNU3Ln2ioEFrj29/Z/c5Tz+2/eFPfmLJEsVB+voztC1pRrlD9B48yML5zTxr73/v0NDQ95O9Kd6ykr+/4qwzrkoc2M9QZw9N4Vo+euNZV//4kaf/odqO3SXMNLbNbU1zBNIsYIckuYKLpwXptIEnarnvwT079h7k5jXXXbNTu4J0rufMRx7fck0hTY0p2XHzmvYtQtaQyKRRhouSEikBEQbfvw6hLQ51O7zrve9IK6XTWhl7q6urUdpDSgdFHtcbQhgO//Efv2xEupfV1uVuu2DV4IdWnj+XqhCksnlqwibC1AjPBdcDYwjZBGdcFSVeU8PGBw6ycdPOl2VK7MKs6urpSf/vslXnPpkbHPL7RdFZyVCj+8/EQpDDhw83RSPRTCweSwsh6OntJRaOYAtJOtFPVDrYhoclwZGKMFk+su72L/zJ3b/f8r3//PZd8eYmamsHWdLU/2uv/+oXqyIR56WeIfHpsxY37rUdmwM9L7Td/++fIjG0ndvfvmJuLKb//tVXXmXHzu47LCP236ZVPSJKEkKhxNjitOFtmsm7ns0WI+K0UsHNuCKxccRpw/lMkF4hR87qMeKwSaYfs36Mn15oycipGf4s44Yvlsfk54vTjt3u7zt5zu/xYEwR2DjMRPtUIuqcYW+8e/CFErN1zxIQMFXKiUoqnb8tl/5UWWA7LCLtYHrzNe1Utkg6EKfNLB2Uf6bSzsmxkPNUYBDf1W+sa6BtmnlPN31AQEBAQMCsEgjUAgICTle+xPETqM2Ke5oQAiklSk04hXc8BWrtkzh22PFnSgxbZE/VKlwIMZxHG/5ExTpOncmcgJOXUyl87ZuZ2RSnlfKN4v8bZrmcYdo4OcarDcy+MG4lgUgtICDgTcrwr9dCoYA0JVrx6SVtC5jXYlIdt2iUaQb6XuLytsJlb2zd+tOdB3h3Y330f25oP/fSeQvqeP7F1/jOX3+Q8y9+N//z4+eeu/MDt9w90LcLW+UwKOCpDA4Wnqeojtfw0ivPxjzyq+NVVavOv2DV2ap/8Op8Pv+sbZv/V0h9eDj8zni/qwvCIxlWDLoutvbDNzoGFAwQUZt0jXhy4QcuejIb6qPz9c4v33jPhStltI/exA5qYmEcB4xi/p4GrSwi4WoOHRI8+KPOHz3zKz71F59/99ZsTmNZBslsHiwDrV20zqN0Aa0MtBJoLdBaoZUATD9MowZPeLjCxcPFExJXSJQIkXc9Lrxo1Ra0syUUsSlYmmi4mlza4s51Z+z8u889cskvfrFz2+WXxxvjMYtsQlMVbsJxEoiwRV0zl4asIepcvnHNnBXrhh4bwuppwUgLBtMJzLMPt9xxxfUf/8lzP606+/IFd7bO5dJlS5ahxF4sK04q4SFULQN9BR5+fP/h197g0rfeek2/pJ5UepDqhrlcc334CVukkTpMLi1QwkEZGk+6ICWGACFMBALw34eiklBMMZBMUFffhOPl8YRACoHSFtKqww5Z/Pqdb+sNhSI/soyqH332s9/4qz17D3zxpusa3i6rFJZ2qQ5bYHm4hn9+TAVWrUXrJYI151/AV7/60hPnLr7w7p2/GmB+ZjEi7VItbbIalCWxveFeMkruUiqI0kbxvRwRqRjSqh8aSv9NrDp+2eKlS365+fXtrz/51JMvW152Y/vqVWlXZTBVBk0eYbhIp4swIe58z413b/jy/7nsmtVzL3ni0W+yfInBO648a/n+fenlTzy2ffHrT33vLYva6r9/85WNl9XUbqV2iYkZSqG0wbkrFnC4Z/unLcv4b1f6oiktXIoffUxx2mhGQjVNEHbsmL2GLraBGLVfjLi4HXUNlmZQbMthYVpRSlc8pkRwVZJmbBe4CUJsjpP+qPKP+XCTS1+K1CBQ/vHlmrQY3nTY/UwXxXBq1OeRukTgJBRSyyMixKPOcTHc41GOdEf/fUz7ja53maqWY7a9u8bLf7juxwoLfWMyoSfu+0ocacPhNj3GlU0f3U6y5FgxwTU2Oq+ptfeYc2NfInDGDzj56GB6ArXx7o9rJ9h/sjCI76b2g2nkUcmc8gME4rTjSduJrsApxsuMPW9Z6VjQyaktVg0ICAgIOE0JBGoBAQGnK/crpfYIIRaJCSaWp8msuadNot7HUzAzmbIW4d9wjWdpXZbpCtQ4IvI4XkLFgDc/bQSTACcDx0ucNsw38MexKY1lFbIWf7yqZHXwbLOe4+fathLfabP9OJUXEBAQMKso5eHioIuqiFwmTzwqWNDaFI4aiggFnEQvES9NQ3McozVOazz81l/8bN8jl52/5JKFTWHIHaT94jls29XDy0/+JyrpHQh5bSBChHUfhshcr3XyjLwoPNyTCqUbF5z/2U988u73zV20oOmi1Zfz9FNPce83NzzkavUXLXOadhkGeDqL50i09tCjLHKGF8VkpcHekIljxIhogSE0edOlYCpypmIwGiYXGWLz7k5x+QX82v7CDoQ7SF2tRTqRxZIgQ758oFAAJeLs2Zvj54+m/+HWtW/9g/d9YBHdBwsYVpiCl8FTYNgFDEOPKBt6e3uLLkwWQthIYSOEgSdNFKC0hwYs5RLCJOIa1MYayOYzCAMitsSwPdL5NAUXsukqauJ1/NEft/c/+vOONaFIauOaGxdw8FA3ixdVE4tHyWcL2CFi9/77Sx9ed039uoEXugjvb+aShddiWg1kB3t49PmfsC3dwzlXNa2795v7nrrxWmKel8e0LfI5D09F8Jw4r27eya49rFn77mv7c14U04oi5RAGBQzPQUgTaYXwLFAmuNpBa42JidQCrW084WEI/D5kC5KFFI7hksgPYss4BhZKSjxPoRyFpw0c10LKCE7e5gt/9YmtydSrt/7s0V/8/TWr+YSYYyK0QyQMhAEFSoEQWVRcMeBliZ7Drz344gv3VIXrda22iRQcQqaFZxoYWIRdiSfgUCFMvnSWURsjfw5ZNjVCYnpHBEZzW+Zu27x9218ozH9cef5FH/nYRz5O545tPPdUx+EtL3b8T7a368+FHowJlXororCrrfrsR/oHk1QrxaYtjx7YjMlNVzWzYK5kaLCbZQvmkj674dLnEn2PXraq+dKFS8Jkct1kM0PghhEyhqUMwraIeMpBGQpPKHRRqKTFEU8pJThWLDUT0wZijDCD47iA6aNEU6PEaWP9XxqC85jcxpP4VJB+DHHZTKb3xhDQDYuZfIM+edQ5GEvsdozISZTkU/zbE7KYrznS9keJ08AXxI1T2+HjTpWAkSOfpZzoTlBs/6MZaf8x9g2305j5jXovi2WAX854IXTHaneNSUHYqJLHGKVtnxfVKPaPkXKEDcCfj3dAQMBxpoOx+2QN0xeYDTuTnQrcT/lwpxPRxsTzI3sIxGmzQQflx9S241eNNwUdjD2/Vul8Zuc4+9om2B8QEBAQEHDCCARqAQEBb1oymcwx24YfsBRf6ym635QRe+1h4h/ybYwvSJlR9zQhBIbhT/QrpRBCEIlExkuyjqnd6E+FNiYvzlnHJFzUSs+fUgopJaFQaDJivVXF8tYqpWpKXNQCAmaCKTsCBswoHUxOnPY4x07grsIXRVU6fnbgj4GDANFodBLFl6UNv0+tm0Q9Zpt1TO7hzib8tnkZ//u0rfhqp3Jx8LUccT4AIBaLjZsgnU5PoooBAQEBxw+tPTQOnnRAS1zPZcf2zuqlC8ItrbU1uOkDGLjEwnGEMnFyHpnkALVxLps3R6LzSTAyZFIZWltMWubPZd7e/NoN//UfH/jt377zW1vo+vJ111x4lyWHeGHLnnx1o5P91F9+vDbeuIysG+IH9/2IL3/5y+9vaa76Tn1TPV0H9yGEQuLiKY3UEZQyjloAMuys1u26ZMM1vJ5LY3l5HJEjbaRwrTzKzeIl83xwwUXo17eviFmipTreSE442DGIaRflKLQHDpAvwGBK8+Mfp5+9Yc3lf9Ddm0IMHuC1lw/gi0ZySJFFiTSaPEoVfFc0BEoZuEr6QgVtgjQoaF/8p12F6biE8g6RgkEkHQXLJRU9TNaABS2QSkO4CjIFcIggRBUWNvVN1vPbdzj3nn12/kNzGxvoHTiEHdEII07LnOqa885IfjIyaDO4O8n585eiMh4qP0DycD9LovPZtPUl0m0Gc+fyyVicGsdLIJXGNMM4rmDHzv088bxz79IVbS+89NKLuEoQsxupDruonXsRHuRz0J+HTBhyxUiEppbEcmGkNrHrq1FCYSmFRKGlhycVSZ0jbNnEvRCmB1IYx/Q9hcmithUc6HbRRpIzz1r8Bz9/avflt709elko5CJVFkv5eh0/DK2HcgvEzDCLa2XLK2m1fM9Q/9a9posbNfCMGDltob0QpmGDNgktP+OYEIBK6xHXu/69B3EwcNG4QuMKkNLe3bnr0Nv+6v/+/R2f/Lj77XfeejMXrTy/icytv/fXf3zbB6pxItecd0bo4L69vPCjb3/lpptuuftf//nrH7z17UvXXnbVPJTbw0DvIIVCgWi4n9Z5EeobubR/oJemTBNC2hgqTtyqBm0iIjY1VbHmbZ2d1QtXnJdUwreFEh5oKY4INAWA347D94vDIpojV0dl8iQhfLcurdWR9wyLpBQI6TsFjojijoi9RtpTSA4cTJaczzEYrpgWxbyOXcg17p1vyeHlQjnORnrNWG1bPH54Qxnx1BiGYGMylsCqXKJTRXQ2FcYKsVkaVnP0eRsvJKccY3+58z6ZsJ1j5VsQEZ7cNIBTJo1iP66w/TdjCz7vR8uTWqA2wbzehGSz2Rmqyewwic9XyxHnoI5K0481/3uSM97itkoEZh2Uvy+vnUJ9psU0+28HU1uI117BMes4Dm5y071+TzQzPH4Ei8Anx3hjQRvTE5hNN31AQEBAQMCsEQjUAgICTlu01huA9UKIcqKqQSa+4e2gvChr1tzToGIHtXWzVf4YTMWprX2qhUkpK22DWo6EEx0RrcygMC2Bv+rvfk6dVYoBM08twcrMk4EvUZk4bXh8nkhEvA7fMWwi8W0NM+P0NeZ4NYOUjlf3TzJtG5V/p92L326dE+S3jsoEb3cTjLEBAQGnOkLh4QvUdNF7JxINU8h6dtQ27EImiS2KUQOLIeiUUnR2ppjXCq3N1WRzA6AVChchXCKhLDE7wwUrQpc8cv+GzDUXn33XGS028XgN1bWLQ4++1hPq63qSmsa5/Oc3v8U/fulfbp43b97DjpMnEgnhFmO7CTRSa5T2UEocI1ADyEqDlBSIaBUGIRxpkYqFIKwxvCxmpo+MCpHPMN/JadAa8NAaPC2QBjgKPAWaMH19eVzN11yq8ISDIUBJF6lAoooh/yQaCdrEQ+IJQcEQuEKCllhKIdB4hkKhkcKPohjyJGFs7EiYtHBIheN4Van3DMV5d+sZVctziczQzk3eI0OJ7N8tavOyVrQFO9bEU48f+PSKZYkPnfHWJSSTvX64OuUQi4VD+UKyORI2eaPXpdvqwoyGMQohHC9DJt9PzoUlrXMxkvuaWucRcvJpwpbFQP8QptVEZ1cPjsenc7kcttbEYhZbtu6KhEN88tLVsbeEw/GqTKZm2+Choe+ns4Pf05YCncd0fQGhxG8fLVSJ2sPEEwoPG0/YoGWJaGeUE5VQSApF1yMbjyipPF/vS6rLWuvDOG4O2zURuCh8oUkumyedTmBqRUsz8w9ptiZllN6CQ064WOE40gtjeTaGMohGw8d0e601SglsVxPxNKbnO18JrZEStJJ4EoRW3/mjT93Vl+n9xMN3fOw3SXZtpj6WrL3mgjbmVnnMq2vFKzh3PfbgQ49ff0X1JXMbTZx0Nx4plCcQwkLhYIVcIlHYs6eXpSsaMQ0L25LgGZhCEouEEEKH+gewFwoX7ZeNEr4YbKzQhTN321iZ59ZoMZUe5RQ2Wn5z5Gr1w78y4rRWeqQCoScI4yiO1E+Prsfk0h8rESqf3pN+WQpxlChPlIb8FApZKg0sOpyNHUb06Pe6dLsorduwKk6O5CkBVQx3Oa6ojfJirJORkfCaY+zzim0yIhIcq/05uq1H2ml0ZmO028g1VbJtrLY9qv1H15EwebLkRHyMT1CR/G02na4DZo52/Hu+4cVZCfz7xcnet54KjDcHMV0HtFWcWm32MlMTqLVNsH8PwfzBbNExwf5TJczsycB0BWoTpQ8ICAgICDgpCQRqAQEBpzvrKbqojcFK/AmSjjL72xh/ZdCMuqeNpgKBVTvHd+XSVARqK5niip4K3M/a8SezxgxFNwMCtQfwJ302TDejgDcFa5l9l6vHCUIdjkc7vpBpIh6g8pW0G4qv9UwspLq2mO+GCvIdzYi7I7PTj4bHq/uZ+vfSBiau23AIjY4K8uvEb9cNxXpNJMjbQDDBFhAQMCETPag+wd44wkXjoqQLWmKaEaLVDGayyYGCk42GwgKBCRhoDX29/SQTqDktYZnKZBCGREsJmKDBKygO7O08sG+3euTcZVX/unLJXARJMpkEIaPARYstnv7hV9m9I8kD37r/U+csbX7YtMBVNngelmGhlMADFBqtNH4bjv6d7ItLPKHwpMJQJp4ZJ2doMo4H+Sh2zmMgL6htpNDc0ITtKRA5LGWSkzYKD6EK5Apg2CEOdifQ8JRGopAYKJBpEL5gSKLQGrQ20Z6JlpqcIclLjSt9F7Go62IIj7wsoKWHhcJEghAMmXA4XsPOTLZ2UFY/HI61XfKGgsVehBUtWT7y+4vbH/vfhz7c21NYk5bprdKO81sfubl755bHHtyz9/Ct8bjGUhaea1JbXUcq3/MccwuXXH37wvqN977Ogfx+5tQvYOfhNzgcynPRHQtJWKovleQ5N8+auvo6splBtBL0D2bYv48fLppPd0gkiNbU88zz+5dfeDUPr7pm9aLNPYrntg9RyNVf1Je13p/P2c/VS31zmN4BqXMoqVAUsGUKgQJpgjLRWKBNtAalw35ITc0Y589vU4FCAl5R9JdK8WTfQApz+Vx01sBUMUDhmDk8CUPKwwyb2KECaY9Ct46TsFvJmQphGEhPYmiwPYWhwETjjYip/JCxfuEKJQSuBKlksX5+XxO4GFqBLPD7d3/wZ/d9/6ufOmtu7otP/ew/WNScJR7NM5BKEo/Usvqy1SSHnvmnnbuSHzPs7HtiNS1zpZnHMCwMw8QpuMRi1bTOHWLXzrTKZvKyvj6GsBSek8cBMuk8jpceiFcxKKSHkKLYNhoh9Uj43VKGtwkxtSnU4VMiZNHZTgvEsMuZ3+HR+OItrQTlhGylo5seEbIW95We8mEx0rBDW8n+8UVXw9d/ecqmHyVmKuukVUbwNDp9uTJKW6XU+euY/DjaGG2k3NHljA63WnK8HKN9xxOljec2NlHa45EeJhbdTcSk2n9U2E5Z0hfHbvWS8LBTqacYJcg8upTaY5zVypz7gBPGWuAHo7bVFLfdyZtz3u1xxp6zrcQBbbx7+rYp1ebEMVXHt7YJ9ndMMd/TDiGOXpwyA5xKYWZPZtqZuB3fTGNBQEBAQMBpRHA3FhAQcLqzAf+BejnGC9k33r5ZdU+rkPXHsaxapi6Gm4qwrRxtHHHteYwy4rRpsAl/cqwOv94bZjj/gFOTWk789R5Q2Tn4BP61O1mR1nrgXfhj+0R1qHSCtRb/e6QTeAl/vJpJcdom/M+7mCPj1VTFaeuYeIzfxNQmIjuL6e6d4LhFHN/vtYCAgICZRUvQNmgbrW00Nq5r0NI8zz10kE5DRo5+YK4ltbW1XHpps1ywcAFG2MZF4ykDT/jpt2zZxq5tqjtqsaZtfv0clRsAlUHoPIZOs7w1ytxwlm999a+7P3LH2/7WyB8gIpPozCAhKRAOfphMbQLyGKemUpQAZQlyQpEzJSlpkiBCV0rQebiwcHuf1/6nX/rByqd2UavrFisdbiJiRxAGhEMGoZCFkL6DmhQR+vvpRbNLCAvlSbSSGAIM4YdAFMMhPIttZiibsGMScUwiBZN4zqQ+Y9KYstfMTdpfnJPigdqC988x5bzTkAXyVo5dHryUNv7+pVTokq1eIw/vdvnBpgT/9uPN3PeL13j/r3+4raXRerJrd3/UEnmcPGzdmr93b+dh4rF6HMcXWMWiMRzBxv/+ac9vhtoaueS9K7FXGByo2kvjlTVc8ZEV1Kxs5ScdXR9ubmJjJBIiM5Qmk84Tj9dwqHuQg4f5phkBT2R5ZeP+yAUXmE9e+663LdrQsZEvPvQCPzss+OnBLE/1K7YmzUs6B4y/c3QjqCgSl7Dnrq3Pyq82pu0HGjLmF2tz5prqvBxpD7MAYpTgYjg8KwwvzlFI7YsjDSNMPseuoSH6DFMU3f2OFpW4QFVrG4WqBer5A9Q+uSm18tUd3e1v9GUXHshpMtLCE75rm3GUoOTYfqTxnbI8qXwHvGKIS1O7GCKFxSB1VQVuf8/Vf/uNf/ls96I5BldevAztJnBwEJZJMj1Ay5y6OZbFmv4+pzudzuC6oJUFKoTn+eXOnz+H1asXykw6h+sKXM8FQ+J6kr7DQ3iOsXvFsvku2kYoG6lspDZH6jmjj2jLUFZsNHZ4wnHTqhGxWlFgJoqvoyVtw/9GzvPo1wSlHklbWlxJg1WSV2nakRoWHcvGc2cb2T/qBJVzvRtbvFe0UBuHYffAY/KjkjY6dZFU0P5jbC/b/iVMJrxnafsftb2iPnpMie349w4vAwOTqEbA8WcV48+tfYOZnTc82Vk18SGntGvScPSBDfhzAZUsMhyLieY2KmnHgKnz+ImuwJuI2WrL4BoICAgICDhpCRzUAgICAsZ3UXsnYzt8TRTOb1bd0ypgLcfXPa19GmnXMTPinloqc+GZLHs44qLUOcN5B7w5uIfZd08LGJ91THztT3fl9XAIzw7Kn+8a/P6wvoL8Opid8ep+/DG1cwbzXT/B/k34bTOd7711xf/HExbfw4n/fg0ICAiYIiZ4cXzZj+/uIkSMfLpAapBnk4PqykizhRAeYIAUhCJR5syLIzDJ5AoIU4IwQfkP4Gvj9dzQHrpA6vgFIcNEkUboAgKHsCUwvDRN1SHOXBDZb7sHqDEHSPb2YYhGvJSJ0DZaSrThe2tpYfgigGG3IK2L8Q0F2tA4Bgw5HiYSxw6z/6mnVnD+qi/Gzl55i+Hlpc50sa3ntdT/e+h12pbdSHXmVVqiHiKfwwzJEeMsrSS5LIfWrLmqkHckghCeV3RKo3iMhkLew3UVTU1NOKkhml1IDSTQ0qBv58F5hhu+b06k7rLGeCvEUjRcYODUpH/nxe0HH+kZLNxw/2M7ImrJxXcuu3Q1h3MDxBbVgNIM0cp9z7xCq93BO959fcOBf/vp41aue7VlZBCSnx7YTx4VDikPzBD09/YgTMJzl1sPfOPnL773qnMX3ln7jvobpYGV1gXn1cE9P3/uB9lvXHrNogde2Ljnili4CkkOywDbDrNvr8rnFT/tc6A2Kmhs0E/cdOvVjV9/8gD/vVlSteIK8qEGMtWCUJOgcKiXw7t33fnyM/t/7/arG7INkdTPP3D9dTfkt2iSe9J0dx9kMJ/45K6BoWer2uK3LVjS0pXIpzEMFztik8tmEbJUzSHRWmHZmoLr9z1DhHn725YW9nfuOOQ6hQYlFTk7g6EVtqeQ2qS2rp6dfQb/8XSKLfacb9WvWRVPEMbLp1Umn31o9+ubP7V8ydKtBVzMkunFYaGLKjpWG0oihMYzNZ4Q4AmEJxEUMISDaWVw8j3IQheGl2R+s7m/oUq2DA31oN08jiPo6euFgk1zSy1rbpnz20I6WOE0QnqYMoqUEkv6DtvVdTGqa02UMvC0g0BjaIFXCGHJGK9vOvTsFTcvJOHYKPywpgIHgY2Q7sjn0LpEWqNl8f0U1/lqMEMGWmkKeaz1qJoAACAASURBVBflSWzTKtpe+UJCDWil0WI4RK7fkKooMhw2NxnWEY0IdnSpeKcoSNSgxrDUEnrk4i6j1SqvUhJl3PmO7B+vbSQTSpW0LJ+9HpVe6zEdw4YFb8UaHSWaOlqoNpzn2HkUox+P6+RViWPZeBzv9KMFXrNR/uj2GjljQo104HJCOCUUaDnS/lOgDVgLsh3/viS4Pz81GJ7Hm+h8bcA/r6dDuNapOooN0zYTlZhh2vHnqduZuTmQieYEVnIk6sWshjydgQgdbzbaCRzUZoL2Co7pGGffdMeSgICAgICAWSMQqAUEBEyJWbB/Pq4opTDNkSFwA/7D90VlDl/PsWK0icKwnWg3pVktf1T7wcSrGctZ14M/aVDLJAQHSikMwxi9eRD/5u3+ccqqlARHRGmnwwTYacUY/Xc6tDG+m2LAKGZp8m79BPvvZWYcD1/GP9/lRM1QuUCtHX+snq7TY4IjorTZGK/WUf77cbj8dmZGNLYOf5VnuUnryQgAAwICAk46NCYKG4X/IN7TFlpZDCX55t7OQ3e3NM8xhBC+KEwbGIYJmCgkQii0NNDF/dLTNDU0Y2gLAwuUhyeyuGJYoGLiuBbxWDV7d23rO++CfYTpJVrXQGLII5nNEK2pxZESxzDRUpEayqGFGFN4oAWk3QJ5A6oa69i6c8cyrr385aq2M0LVtQ14uQIxax7mwLz4Y08/yB//4/38x59cBu5mEimHKqlAmyil8FyB8vCkESWbdolW1+B5Dp7noYrhPRUKw1JYIY9Dh7fRUN2Em49ANsx8q4Z6V3/vjLp5l57ZsBArp+ns2sqm7VtZdK3Ne95+4fWdD774X1VV5qbIvMV0J1z6Cx5hy0QoyZBqIKLq+PHPt/Nr1y3n7t+54uIN//X0E888+8Rt77rt3J6XfvXaf/X1pj9cVWdimODpPEpwqD/vYDRG7vvxvr2rYg2xG7QpAVR3V/bF5sWh+yI1c8hn93QfPNBL3fI4hmHw/7P35vFxXfXd//ucu8wqabTLi2zZjuMtsZ3YcfZEZC0JISYFQkshLlAKLX0IbeHpAsX0efq0lBZSure/gmkIhLUmJGwhoCRksxPbcRzHiTfZlq1dGmn2u5zz+2NGlmxLI8mSvGXeft2XZ+bee865d+49o/O9n/P5Hm3voG+Ar6+/+6LU9x7dV+9U6G9/9L65azNGjh+2bMeovpwBvxZHlUPIAMNHWi7SClEZ5WNzopFVH7ntxlte/+mz5PbYzI4uoDa8mH4ZJ5g6cuXB3T3fqYrMujoYjZAKJkimeqmurqKrq4tINIryFUr5+MoD4eD5Co8AoDEMA1PgJxMDBAOAdFAFAaErwrQNVPLJL7/C6/4c2XDzO6JH0i4hBSqbknYu87Z419Fb2uK9K6uq6vamExkqpCD/z0QrVdAB5V3olAAtFUKD9GU+pabSSOngZvuoKvOQqTYMnSEz0NtbXbmScEiSSCSIhkJIZSOsIUe9IFq7YGjAQ4pg/m97YQIKX4JW5NuBRqHQWiKEQduRLr+/lwfxAkhtI4WJwGJIFCr0icK+4wiJnowV1CikkilCoQhSSMLRCE42V6ijuHPhiQK0oRuSYcGnKLw4Ke1nvt0n7TMlZuYBvBjt+MbfizPjdVdiWimWInYEE5SCxjhR9FJsvFLi3CRGXlwxke+ugmGR2oU+WWmi8cxDjH7uzoV7YTX576qZ/MTvmWAisY+7T6p/NKeq+ATLOl/ZQf4+m+77ZgdndmL8m5ELUaxaokSJEiVKACWBWokSJU6D812cprU+LpAYIZTYBHx2jF3Wc6qAamORKr7G2Q2YbGQGAxJjnL/mIrs8Sf78Fhu4Tjhd5sj6R2FIpPYAk7eJHxJ5DC0lLkDGuH6nwgOUZmefFtMoVFtP8T7vENMrItxUqHOsQGsFwykrihEvbLcD+NJptOMHnIHZwIwvBtvA9P7mrQcOjlPfxmmsr0SJEhccY6lITtP5aDoRHgoPhAdIci7YIYEZpCfnpZUUwhDCAG0gDIkhAkiZF6j5Ejzh5l1mfBOtPLSv8L0cqBy+4ZG2PbRQhHwLtE1KVPL0S6/0pB1+/TvfebS+ppqFISO8ddAzvca6BRwdcHGkiWO5eNpFCIHU4riIYPhMCrQwyPguhCyO9XeBn/zH0NxYIBPOklPdKO2hVIRMyqdyxa38dPujfO3x3Xxk/SLKyjrJJroJyyihgI+wIgRsah740s/khz/2GyqTzmEHJI6bRIgsEm+FFNk7K6siF/f2D/T1JvhpIMYTvXIBNeUXsfW7T7/nHauvunL1wlXkkilyZJhTuxTZFeGZ77xE2fwjbPiN2977xBs/e29H+nWV6FskwxUVuNkBHBS+6yJdh5AFPW3HqJ2tede9867/0TOH9z/z0q5PqzQcbu3lilkxlOXj+x5ph7baKPRq81/7G9Z9ZGtCkHUsQp4XWL3Q/vRgx4Ga3h7/o/gcTaXAsizKoiHa+3ro6YMXt+z7+K3r+KvrrlgYaYgF2J/RRESAkGPj9PuICGA4SM9HpBVBJ63mRPjbz7z/rbQ/vIXORzt42zvvo7cni5HzmFXeSI2cQ6Vz6Ko9Pz34nsZr5j2sG/vJBZPseCV5c1kZt9fU21W5XO6NdDr3WM7h1USqF8OoQOq829U3Hnpd3nID1bHyKInePkJloBA4psGAbODBX8Z5oUcQvGoVr6o4ZtRGuT6+cJDShVkVwdSxrn/qdXO3BwSUGRKhJAIB8iTHK6HQwh926BOgvByGdMhmepg1P2a++twTVyR7OBAI8uvPbHnlwKpVdTXRQBjTg4AtcbVPzk2j8RBCYpsCywxjyAj5FLUKhIfW+rgIVCt5/N4zTMjmBlUwTLevMpimhRAahJ93WTMFcoSCZmTIQyiBp/SExFQn90BDPY9hGEuy2exflkWq7/V87+TdTi1nUmkNRzha6RH1jkx1yUkfnFJAkcJnIPwz7LQ38X2KuX6N7OGnqCUcLnMSbSyWIvNc3n8yAsGi53/UtKojdx57/0kKFJsYP750vtNEfky0mmGHsU1nsT0zQROTz4CwirzQZgMXhqCohaldx62MHQeZ1CTgaeT+wnImRHKbycdxJxOPG+t8z5SI7lzia+TjKK0nrzjN5zwXulD0XGCqboPngli1RIkSJUqUGJVzIEJbokSJ8xEhxHltYT2KyOkB8gPb0RhybBmimeJ/5G+cStumSBNnwM3ppPO3muLnYyKCr/Ec2E6pf5zB8/3k0/mN9Z2ORQslcdoFzzgix8lQTKRUYgxm4PdjwwTWT3fwbAPF+5cNkyjrAeAd45Q3Gi3MfH/VTPH+/ckZaEMr8Lki6+czyd+MEiVKXCh4oJOg4qMvehBwiuzvAH2g+/LbqiToeOH9yCWeX04pf4qL6AMjjjbjaCOJNpOk3S4CUZ/qBt5X1xCzhh7qn/B3rsiL1aRpoE2JMCSmGSAQiBCOllFeHiMaDRMKB5FWPmud5yncnMEPf/j8N/fvT12+dCEfuuuW6gM3rK57tiaQeq39wP6mbKqLZLybgYH+8oGBgdmJRHK21roKCIx+/iRoE9eDzt27BBXlV1uWgefmcNwEhq3pS/TiGDbdnklKmjz/8gCuCNKfSJPKuDhuGuVncZ0svstsy2ZuKpuGYDVZu5puETbbjdA/HrYiu1qtis+n65s+uOSmaz95+3uX/7xPpVq++eiuup5kG/PqZ70n7IRIHuunTAaJRSqQjslcu5G5VphXnulmYUMtf/KRO9EdOyVtL0Hb6wQHuzCScVQqiZtOU11Dnytz/Od/b3vp0Z8ffqVpcTh6w00ND8ybxwdzGYltRZEYOI6D53Lw9dcwXCPwkZeOpTgoZ3HAmM+r6ShP7jyGQ/lHXt9z0LANDkYCgoBdjpOVHDioWXSx/OCylY0PzJvfFHl2y4FX/u6fX3tpIJVj5bz5fdlDBylLpgn19SDaD2H1HCAQ34OZOCa//De3YIs+uva2syDWSK4rSYVhUW1G0QkPkdREdYC6ysr32EHFt7/bV5eFlnf+7tt/fvW7f/2TPeVzP9gRafh8W6ByV5sI/ONrx7JmygtgB6NYlkGsnMZYBbMtoaiMgOHl03GCxNdh9rZm8Yx5pPwych5knQw5N4GTy5DL5SivqsIsK7v6UF+78MOQs3O4tosyRkwI0QWPME1AaFUFarYWarYWlOeUjyaLzrpNtWFnz7WXL3j21hvqD0RtPvTaaz1rHn109zd6eweQ0sJXHoGIRVksTHlFmLKyMLYVREobrQsPVrWJxjx+raJlYbFBmximoqo6ZM1r5P1aZTCMFMJIIWQOIV2E0Mf/Tj1lkUPOggqBB3go4eFJhSfAE4U+Cg8lPXwjvyiZ/8zAIYTzlcWzYu/uOdz+25ZyyCczVAVxTkHcpyVSqy8iVJ0W5FMeClBCMpz0ExCFgK4k70Y3dJdqkPjIgnPdkBiwsOnw+8n+KS44no4079Y22uKfulBYhD/GPvlFoJH4mNrHKCzmiEWSFxGeuN/YxyOhkNo1v0g0pj5p4dQ6huoWhfdDxyHJfzZyOX5sJxzj6Mu5vv/Q8Y48B5KTzv9odY5R/9D2xvFl9JSsx9ECX4dxRPnxJcfw4orwkOiwmQvftWcj+ck6XyLvtH03effuHVwY6dpi5Me/BxlbfPEDxh4brwK2kz9P5/v5WF1kXfMMlj1TbCJ/3Z5JUczGM1jX+c595O+7DdNUXjGR6Nm4/t7MjOYMOMT53k+WKFGiRIkLlJKDWokSFzCRSGTayxwpKpBSTilNXjqdno4mTYqhhz0jHZQKr+PkgyRjuahtYHjgW0wA9jUKs5HGO75wODyBFk+aTcygm9MY5288oUAL+fNbLM3n3Uxght/Ih3W+7+O67pjbhsPhTeQHzJuZeMqAr5IXPmwYry3jMUPf77TVfzbuv7NNkfv/dBgKrJ4VZvr7O83rt3ki+w8JTMc4/5MNnsQoLhJ8knwfdAJTPX/hcHi834wbyQuGWydY5Gby528TE58l+SXy/dV6JtlfTeL3abz+feNk6p0ED5D/rR3r92w9JTFxiRJvPnSWD911BbZOjrraEWEee3YvOREddX2ABO+56xIs7YAfAy0RIgvCQeOjfB/tg/ILYvaTHqaP5vAyGecfKQdYs64OpIcrgqBtRFbhpwYJl/OOWHUUITUaebwuXyu0UvlUnxK0ZaJ9l6ASGBocNEqDKWzQChsffBffC+A5Hv1dxOfP5+9XrJz3rkXz6ig3YFek8yIpa55VFdXbbr37pktnXXxpdcbQkYF0io7DHbz44jZ98MDBH0tDfqu2rvZBCpqYnJQcPeriOy7BpkU663tdYpCySMAgZ2XJqTQ4CikD5LwswhbMqgTV34lIx6mttnGSOSwLcm6a5csjYl97am1VffXh9nQNHVmLZ/oD/+VWlr8/oYLEE0mcn/Uxv7yN97ylinvuu/VGJ/v4y3t/8sZlHOWhyyINd4uERTaVwtXgJQcZ7OyAVJpKG9p27WVZTYy//djVPPijnby07zAZO4AZnYuXinnZwf5bZYQ7e1X3H/dptooEH931WPrO2or0VWaSVC6hPplN2VUyGMB3ElgCv7oS2R/PkXJzJEI5coaFZUB/LkUi51EXsWWiF0+KMgbiIK0Ah9robY+rL8jQkegzWZ5ffFH9Y910/ms8o9eEcvGvqANdj8qc+HntrDoz7XZgqS7WzA9w74bVNFQkOPD6IY55SZx+Rc2RViqtKGlPMphy6EgmaVOdvOR3PNT2Mg13/zbb3/L+uxq+s93mwZ/vRlZGyfoBHDdCKJX52MWpUFn1rMYN0hnETRwiVsba2fWmyKXiRO38tS+ljZ2DClswN2IRdbNk+wRGOARGH3gOpH3IQmYgg5d2uj3l0K8HMCI2lmdTnjYJ6QAV0TKRHBh8n4Fxb2VZxVtvar5BzGlswg7VYtt26qVtT/f2HfnVK1Zvz+XXrayZtbixDlOIcFWV9cVt29qu7uujR+IhbY0S4GkHjcrro5SJhYX2BUoU0ogi0MoCAgVhp43WoFUUJRwkaebOjxE73P2OmurI3/TkBjCkRGEjtURI/0Sdk8p3AhIQWtO4YD7aV1TVRUhmkqQ9D6wgwoxiCwNbp5F4uDLfN0ghQGmk67N/x+77r1ledc2iObPRvV1fOdrT/9Tb7v31/Y5h0R3vxrJsbE/w4pbnr4mn+z5hhwLfWL36yi4lJJalyeR83tLchHIVyUw3oRDEB3sIBALsfHn3bVKaXY7j7JAFER3HWw5CFOYmS6Pw/tSOS2uN0npEGtNTPciEHMuj7ESnvBMLLjYv+sR1pziAjShrZKlD/eNYgqeRpZ7ogDaar9robVAFceDx+ov29aMff74sefIWY9Z9ytpTHMkm5ws3UUe5YudzqAzFqb+BRQVnHBemFvaXKDH28TqU8+0fH8AjNep6RT8+9mpQvxyzkKHva+g7KHrtTZ6pxncymUzR9YX78n7GHl8OuYc1MwPORWcofrWR4mO8ITYUlmIu459l2K1r09mOv51mfOG8EY5M4PxuIi+AOtM8QF4MdTbqPl/5KvlY1cahD4LB4OmUU6wfmtS1HQqFiq4/1w0Sxrv/x+v/xzn+5kwm0zKF/VczSky0RIkSJUqUONuUBGolSpQ4baSc3oDPmWQMB6ViD8Tnkw+QtFBcDLFx6q07be7nDM0kPen8FRMwHGJ4VtVmpinNJ4BSEwrQ7iA/GBuv7pHcXdhvPRdG2oASJzFNDmoPULJLP5mxHxichJRyulJFN4+zfiZFhMUEajAsOJsoO0bsM1FnvhvJi+DWMzNBp2L9+6jiv2kiTv48jJWquXmG6i1RosS5jPawdZKw7h1jA4VRJA+dACwGCep0wQTIRIgk4KC1j8JH64ImZbS/M0dJgzYpuYDOYugafG1CweXJCggOvX54zuyYsa62thpUAgApTaSwQVsYUmIaNsKUGIaPwkIoicJFCRcXiVAmQmhMgmgkjrRBGlx7dflHo9EwsahAZfvREmqjJpVRZ9b7/vhDdzLnVo62dvLCzi3e7j2vPdfV2betv79/u2EaB0Kh8CFGGDZpqdAyiyezaCMFWmwceH3vg6E5jZRVWiRyDlbAJJMaxEAgJay7bAG2VAwkIGQ4mAYYJli+oqY6THVV6te7e9q/7wYW8rkv/GedXlL5/mBDI8HZjZQbIVJdfQwMHOSLD7ZQbgo+/anbG3YueGL3zoe8Lz796pb96UzdwlmROuFikIqnqQ2WkeihtzZgJFPp/vn//d0t365dgHvLkqbfXLtgoWhP+LzeltqRssUHFi1bs71CvrhaCs3i5eZ9h9q8j15yyYLHolb5Y3owTqL70JV9/Zn1NbOi2LZBMMhKIdhWEQodWt1QM/8nu14i7ZuE3ByXLpzF7AiHaqTlJgUrhdBUVFZxsO0orstTs+eJz4vALI4cTXOkx+WSNXX3+UoRSKeP/u5dK5585pVDV86qqP4vOxJdfXHTLC6ZE9b7XnzuG2/8DOs3b13wbmNBxaF9O49GZw/0VWf9FKalSZk+h1Wn3uMkDkRXsOQ33xb59+tvX1v57Wd38A8P92EvuR0qy8moHI6bwwtmeO1g931bvvzdT/79p+7ojsUCVMW455KlTajsPpD5a1+GI6Q6eyCW45pLlvC9p59l8EArtcsuJ53TeMpDZTRGTuM5CjLpz1Y1VuuknyAayIEUkNOYmDiOqw3TbLF8eRBXf3v3tl2rE73JtQsvvuSqtevWRNaufV+ExOp5X/mLR5lXZeM7g9jBALProuiVZe8aGEhQWV5O1nXwPZfy8vL8vSwEUmp8LcAwEFiFz1VBYCZBSrQWmKaN54HWioyXwg5EKIsG173w3LNzLl5z6VFfGAhto4UEaSL0iLta5l8LDUIKysIxBhNxfN9HGhCLlJHTJjnPwPM8TJV3S/OMvMg0lU1TVRnlhed2z7uoli+tWrKA6miUW268nB89se2ZH/3weytvvOPOrnA4gmWZGBkHKXP/cf01l/Hijl2/WR4tezHjKlK5ASqiFWQHBtDKwxRpQpbJoz/fes+iRdGP1ldEb+nuHbzX1GZh7OoVBE0FB7mhfkvogmhnZEd2ckyniNjs5B7v+Hp10vuCexvGiVWdIhgafi/1kBBwpGCqkJS04BanyAu1BGOnhBwSRA2VNYRxgnBvLIbbY2jQyOPCNEkxkVqR4x9RsjrlXE88npavf5KJS0ccf9H2ixFOh0WKG02kNhbHv8/j9eddDccWqUl8DTkxpggmpi78ySlNFBdkQV6ktpEzkDVhmmkmP7abSPzkB+THgpvJH2sxMdvQJNP7uXDSfg7RNIFtWhg7znkmRSn3c3YFYhvIx0QmIn4skeezDE/oPl1ap6cpJUqUKFGiRIk3I+evuqREiRJnjXN95sp4jBRFnHQsQ444YzEU9BiL4+5pZ4HVnCFx3EnnL0Zxt5+WEa/HG/g2T7b+CRIvlP0Pk9hnPsNpA0pcQBS5/yfDekozNKfMNP2WNBdZN8DMPsiIk+/3x6L5NMtcT/EUlydTQV4cON1ivCaKP0TYNM31Tab8+UwsaF+iRIk3I0KNvgAnPoJXI5aCkGMmQyQqiHRmI3NNSKcR6dTjZcMcO8Lb581dQDScd37TSiClgWkaWJaJaQexgiEsO0rQiBEwqtB2GSoQAdNAS4HGBsqxZTW2WYVtRQmGwyxbvpjG+bUEQ5D1stjRGIFoGfNmR9j0L3+b+9+/97Hv/s5HPnX35/50Y0VQGDd0d3bdr+BrZWVlT4dDocMnNF9myQQ6yYaO4gW7wej7OoOdn860tZFu7cLoTZPt6oN4P/7+g68Glf6Qr5TXm8iiRYBUykDKMIYIYgqoqyqjtop3tvzsx1GVUEg/8qFw7cX4kTpSOY/uvi4QBim/jEyoia99/w2SPRmuu3ph5T1/0PR/rvxQ2Zyuxrh4NdTBi8m97HV72N3V96NOl1WHHP/xVHSQpGZ/MsVv7dnWujDduvftVYPHLr+2jsuam9zt8+0uBg7wXLYnw8rFC0JtB/mQxEPKABDjcBs/6ejqQeFSXm5QFqVZC+g/0nVnY+KNpz68LOy9t26Qj11a7t1Q6z01uGfXHRWmQW0NzdX1Qaywz77WLjq6+WltzRwClk11RRk9x/o+NLshFlLZBCSSz1Vph9tX1W+7ol5f1piNX673t7/92Ue3L6wM1P2W9NkvoyH22x2PH65i1VNHD/5oby7FQbOX7d4+OhcmxOJ3yTnv/vDs/3PDTUsq067LT39xhFhDI74ZwBfgi0JqVsKkglUkXD4kAgZbt+wuu3gB76ypCIIQSANMw4bBJL6G/p44Ri7pRVz1wcDAsV3u0YP4xzrxjsZxOvvIdHfj9nd/2pxT+fV+L45ZaaHksHOR5yl83yNkBw6H7MDTTsb92ty6eZ9QSe/6v/6z/13x4ffeffdf/dkffPer//Q3uaVNDVjSQ3kujuMQCARobGxkxYplhMIh0JJgMIqvjXyqTgQYEh0U6JCNDNRiWrOw7QrsYIiAHcK2bUxTIiWYplkQehoo7TFr9myOtvF2qSsxVS2GrsPQVUhpIwxGLAIp84shLOL9KTrb46FEv0PQKCeXcNAZj6CSRIwgESNKSFYRFg0ERAPRYB3peIZIgK9fd+0KahrmYAXLWbx0AavWNtVLyYs/efSxxmwyjqU8Wn7x6H9decWCFfPmltFQG/79Rzb/IOJmHUJ2CDyHsEjy/M9+GNi77cnf2/HUEy/fcnX199751utuaYga2G76VUN7CJ0X6Uk9LBI6wZnslD5RnbAIyfHl1PXTy/E2TmJ4P7TtqG5fI8RpM8HI9o7W5vN1/XhOaCMZmWG1WPmj76yQevRlAtfX/Uxuctgh4BPAZQwngS02bjsXmKjo7OOcX5N1NpEfq07k+3uS4RhcK/lx8csT2G/IXW4qaQWbCnVvLpTVQr7t93N2nM6aprj/mWpzjMnHTb8GvAOoJH9vXsbYKV0nykby3/8/TENZbxY2MbXrpHV6mjEmQ885WkYsD5B/LjOT1/fZqnemOB/bXKJEiRIl3gSUHNRKlChxWlwIIrUxjqGYi9oqigcJNk65YafPJs7gTLER52+89G8jxSGt5INLYwnaxivrhPpPg/vJzxB7gImfq8+SD/5NOoVeiXOXKTqoxZh5Yc4FzTT/fhQLQp+JWfabGVusOJUA+Uby/dUmJt5fDT2sWM/0BAvHa/9Mn98d5B8ujfUwYzWlWbslSpSYLDrvXAZDIg0PhEJoG7RA+Q5aK2ZkpKNNpF8GmCgJyCy5jEtFhDsaZ1WTSef/1JRSYkgTIQwMaWNYAUwjiDBtFBZaCLQPnsjhSguhcpj4mPgggmhp4lsuUrsI6YPwUR4oz6f96FEqquYQq4Jdv3rm0YVXrHzXnMZFSL2YUMggGg4SMiy0r3Bd9wTHYi09HKsf1x4AfHBDmLGqv/IOd3w7p7knMKd+mVapJMcOP3fb+37roXrdytbnf75gcVnNny+aNQ833YXjaAzhI4wctk6yYkm5vbd18HNB+v4obOSCmXSSbNIGB3LpDBoHU5vIQBOOm6ajdYA3XnujT0Fi8fXr5gfnQd+RDL2vHdoTb0vev+LK635qeVG2Obvac/hcvpo/+tXTfPbSZbNalWO2drYfw9SCoDSw0TTMN1/oPprpvGhlef3iBWyUOvX/STxcbRAI873euPtvaJNIyCIY4HbTAlvIV9XBvn9Z3lS+bt5Fq8x0OuHt3LP7X2YF2a0yXcyeze31c8pJuxk6e6Cjg++5GUFAmHjxw6xcYG5cNLuG73/v2c6aiooXbBQBM4fKpKi2je1Sie12qIIdWzutt91i/VEym6Hd9duvWL/yaOQV487uw12/FqzxvrR43fKl9oIwvd7h4P5jxw7t7TxWVjN3UVU6DSIawJCSVCJJzvfQWQ+V1oRVgMrGOaF4/zFsycaFTQG7o30fFWELwxIQiuKidgAAIABJREFULKd7fzfhutl07k+x44W2v/nob9zxlZ7KlV/5f//80HsJ2FejVJSceg2d/T4N5Xs9laSsLkgml0DL8uMp3IUQeL5CWPnXWmsikXICwuMPPvK+dG/v/kcCUeeR53/54+8tv3XePeFQiFQmRyqdQimFlJJoNEo2k8U0TWKxKpLpbN7J0Ff4ysSI1uLrKL4XBa0whIcUICWownhx6H8hTCw7THwwzay62dRUHbjD0KF/VaIMTRCls6fcskIM2XWBRlBZXc2hw4fv2ftGx2+blv8T1+f58nJ7S3XtHKcyUoVQEq1ttDRQEnwfXnx+361rV4nrFy2cS7w3ifZ8LN9k5arFeDaNL25v3fb0E0/dmEtz51tuqPvA3FkRcl6Sxtkxu+3wwJ+FA/x5MpuhrjbGww898sdXrQl/oqo2NHvJkibmzZ9Hd1cf0kmQS2BZFR5K2Pm2c4KBFlIrtBYFB6whizLGSYN4uqI0Y/xNTkKOIXoqcWYYEjOOuR5ATzyt9ckOdkMObUVTjWryKXyH9jnRbW3DxGrmEPlx1KZR1m3i3J5kNpmx4ybOj8k6zYx/zp8kfzybOTXm1kL+vDSRH+NuZOyxcUWhnMmOwYcEVqM5d99Ivv1fIi982jhKG9/srGfi8YqvkT+HrSd9vqOwTDUjSCvDaV/Xk7/+mik+qfrNTAXDwqvTZax4zVREUTHGzoIy9NkDhWXjFOoZrd5NjJ7NYCbrnQ5aKO6meKE7kJYoUaJEifOQkkCtRIkSk6V5ktu3cn49QB4vrdhYA++z6Z72AGdvwN08zvqWUd6P1dYK8kGEmRw4bSIf+Ghh4kGUoRR6Gzi3BnWTDbzFubBSHpwtNlNKG3AuUew+aDkD9RerY6r98maG06FMtKxV5O/z+5m6kLLYuX2ZMxOcb6G4APBc6pNLlChxHuC6GuG5SJHDDkgM6SGkRnsmWgo87QDDkyGmU1QtURjaQwiFEh6Q4ZVtL4ZWLQ01x8ocTJ0l5ykMM0R1XS3JRJauzl5SCReQWOWVNC69hGCgkq6jCdq7HX72wjYWNVbwjjVN5Prb8QmjpMQ08w/6HTdDJpPAMA3qKmJYZhrb8HHcNNEoyXnlbbg6iSuC5LwcnpPEkYUUawK0HD5+LX0UaZA+0oRQxMRMG5jz5u21fPl5jeSaW+8AmSQo2yj3EkSjVZ9+5Ic9d3/gN+suqQhXklNdxCpMbNdnsKuL1Svn8sqewT9sefyBjUHBA/0dfMYMLkEHw9A/gAqHSMUTWBno7cm8iFuxtqcDt2U7lzbM27LEtMKL4t3pnqUX1T7RuKyB11NtJP0k7Z081tOW+cy6ZcvsF5987VPpjPorGapC1prkMEGHGYwnUKKOrS8c+8Llzam/u/PX5s75wt+3ffHqawJ/GLRns2rN5T2//NW2Ry5fY719dnUt169zG77w5cElS2t179rA8oeX9jcR6DfIyEBwvtn48M72g088ua+v+r6PyAYj4HOoo4/uHh655eamHotyMvEu/GPqi+vvXD7n4J7XaDvA385riuESxEeBIcjlDMK2Qazc4eghPrVq2UK7vTtOXw+Pdsk0DaEIocVVP+kp935ytOvQzbm2VE1ZBftffoU3rm/mjUi5TXcbL/WV967Jul2IiADPhTTItEQN+PiD/Q+8vOVo2U0r+cMVyxtIxQ/h+iADEbL9CXw7wqE++PFT/btWLFn6mQEUZjLO/R/c8NB3fvDYQ74wcaXElx6ulcS1FOlMHwgPKfOTQAwMpBAYUqKUwldgGBJHZ1A6hc51UVGRwgw5VFWZifLKKpJZhdKCQCCAaZh4vofjOBhmXuyUTCTxlCZg2ZRFQux49Shb93dy6RXXM7dBUma7lIfCHGltIx6PEwgEyGayzG+aTzgaoac7jsQFIBiWzG2sbd66ZXtozZW3ZYRtkHVctNJo4XMyeY9Fl5w7AHrwJ3PnRL6+ZMmcm7u72shkUu097QefOtB58FELfnTxksV9KlBFRU01vf0p6qr4uxWLF5JK9BMMVCKtQD5NLh5XXXUZkUi05seP7Xp17RW1rFu7DCnShITBqmVNpBPyk1Hb//NvPPTUkqvXln9v/dubVqxcMoeG2ZU4bhbtDOKl4+CkCRhUqCHh7RgyIJ1XAA3r0wTHt81r8fSJE8FOSscoTlGQnVAQw8K0kY6Vp24+2gdiZDHHPxMnbCYK5cnj74cd+07cTo1e3aSFc+KUNo1emlE478MJLU9o0PHixAmCwFNaM+7PjVHk3UT2H700XdBhjicQFGL43DPa9ietO+HcCQA9Zhpu43hhw+dnxKW4momnhlxfXHQ5Y2xkeNy26TTLmMzYaj4zHzubDsZzhfsEE3MBby1stxk4WGS7VeSvl8nEvVqY2Fh7aDJYMyWR2kgmOtH4LRSPnUz3Od3MifdHE+eHqHM6aGJi4lAK22zk9J9ntDJ6/3y6sbAYE7snK8hPKG9iagK70613SAA5Xddt0zSVU6JEiRIlSpw3lARqJUpc+Ez3PNRfTnL7z3HuzSwZjwcYW6A2FhtnoB0TYT0Ta2sxF5qp1j8WT3LqYG0Txdt7JoJsO8gP/lqY+KC5AvgfpjZrsoWpzwgcyZcmuf2TnF+pIM5FNjL+dzhAScB2Jil2rlvOQP1xijtDTjZAfjI7GH7YMdpMztGoAL5a2O9+Tj9oVkyg1sqZ6U+KtX0qDnUlSpR4kxKNlGN5GkNamLZicKCDiopKXG3T1zsgbUsohJ6RFHFCKwxyCA1aKxBZQjZX1ldHo3hplHbIpn3K6ip5+eVX6O0eQMog4VAFIOnoP8zBY3HK6hbT2WtRWTcLM1BJXW0dWhr4aHz8/EN96SCESzzeQyxWRcAuI5XKEBE2WUdxpGuApMN/Y3YgRRypqgp5/bzix6A0lg9SgaHA0GAWXgMEXRNDKoJGkoDKUh5t4JWdfTf/5Ind+++6dUlU+xpDO5SFbBpqKulLdnPdlVGSmeTPr1+//srf+4fNb8MwvyHK55VbwsBt76AsaJPoOvpn5Yb7hXhPMnXjTVfX/+Ll5z4SKA9/IVJe86IZSeLYgl4yyNoK2vsU81dWv3CsK7Pv0iWhi664jM/9ckvnfy5dWd4lhAnKRPg+tmHgiwhrr6v/++/+z57fufe3Vix5z3vSn/jpz9rfuGJN/b8dbDvGwVY+++LW1rffcv0SFi9oZP68V/+XGND95dpkQWU9OuWzq7OdTt1FNMb9l8+jqqmxloGEz0vb+mnvYWP9LIvEYB/bn+346B/c1/CJ2soom77Zv2fhReEvZnwTf0S6RTNgYpoeRw921N1yg9wYDIZ54cXX9y1avGCLrWsZSMaROAwGFI4lnwjaZaQyCaqq+dQN111T/+ruHkfmuCrdnfikL+L/LyxCCNeFlEEgnRl0ju39zf/78bv7Ord9c8vVaysZHOigqiJCyDJxsuDoIJH6Rr76rR3JQ33cvLApiKHA0h6272H5gIS8EMpDaQdFFsSQ+9jw9SO0xJQWvvLz14uhcM0MyDg+PUgRJxAKkHHd/966a/d9V12ykKpyGyF8fOXje3mhmJACKSWe5xEtryGbSpOOJ6mtnYvZ4aEDs3jljd1UhjJ4fYfwM3GEEITCIXK5HD09fTTMauDixXPpao9jWSba1NTWlEUPtw9eKQy3RRoOmhQa9wSB1skC1VQqxYoVK3pfe/Xl31swP/Yvv3bL9biZ1KzOY1339nQM3tt2uC/R1rb36ymfB9bWXPnG4dZdSxvnRFbOaahHCB8lFEqCRqKAdCJJT8cR1l1Wy0UXLcTQDqAw8PCFpCpmWQ9/4+dPX31FcM26NUtCi+dUgpeks6cN7btEIjEsyyYSjmJb8YpTPeAg7xY59HpIyKXGcU4rocUk/eO0LJznsfaS5/w5V2Ls9JwTdU47uaxTdxv7rGp9olO+GFbDNU+gygHGFym0TKCc02Fk/HB1oZ7W0yinhYmP9+D8EKiN56L0JfLH0cLw5OahBYbd01YXlomcn8k4N21kckKa6UgleqHRPIFtPsf4998OJnf9T5ZWzq/J81NlE/m+qYXx45NDrnOnQyvTG+fexOTuySER3oYzXO+qwj4TzgQzDjPxvKZEiRIlSpQ4pykJ1EqUKFHiVFrJO6JN1P7/bLmnNTGx2ZmfID9omu4BTzPFB7qjBcvGS9nWPLUmTZg4+aDSJiaX5mFo1uQGSm5kbzaayc+UG4/1TF7IW2JmaD1D9RQTUU0ltcHI8tczefH0fQyn/Dyd/qpY2+9mZgPIE2E6zm2JEiUuSMZ+AJ5K5WioiDA4GGff7iML5s3j5nRy8BZDRrpisapPpNI9CIYfxstJPpQvKmkQComDpOAMoxW25Pq6WD3KUWgfYrEq2to7ONreyaz6ucyffxHRSAyQDCY8tr+8n2d+tZOPff4b9PR3cuzoM6xeWENHZxeV5Q14uT4QWYTIooUiUh5FmiFSCUlfXNHZ08m+o4k9h/rYuO72db/oD6TwhIP0THwvii/c4ykRAbQafi19A9vNu6sJDdK3QeVTpvoyL1KzfY+A8ghohY0ipxwuXlbetXPX4HVV0dd/cd26eVWWEOAHoDxMlegF4XHDdZXrftiy+R+vn8sf/GrP6wuSme53MnfRAmT/QFr3/ujahZU763Ier7/x6sNNdcvef9sd8m+/9s30d264Id5aEW3AzaRxCZDJGvgVjegKyYObn/5Iff3+n9/2tjXGgaMv/fIr/7J39QfeP9dFRfDUINr2iFaUk3RcDhzhxm9++9Xn7n3nFQtq6hr+9V//Y8fF8V7+7NfeetGOx3+675/XLM38/uw5Fdxya/nvvPr44N5k+z61qzMhg6KMDreXdLWnKOMdV18TW9zYuJjdrXFeeP7IP6+9ev72nTv2Bsts/vqd76m+v3peDV/+6vMHu3I0mzTgGBJJFls7SDzSWvOP/9Bj/8mH+OXbb7rSfGn3Ub7/GL97670xUjkfGUlj6SxKKoQ2UZbkqV+x4DfezeeVTrHt+TceXjE/5mXVwr/e3RF/LJ3suAPHrSBlHnRTXd/9qw9f2de345v/9M5b7Svm1gqssmpsGUTkDExtkvZyPPSNHX3bj3DTtTeu68ombXxtH0+NqwT4x82q8kIqqbIoP3/PGHrs6983PLKBJK4Rx9A9oAdJ6xA339X8i2d+2PIbUh/47IJZoaWVEZNQKJQXmQVDCEQ+5aewsYwIvhC4uX6qa6owyuMsXLmc+ugV/PWf/QHrlka5cs0VVNXXkx4YIJfLsXfvXg4fakP7GaorTZAKYSpqasMgO25AJlswM2AMokkP38FaIguCLg1oLbDMCFWVtdjmyw8eO9T5QOfsBrs+FuHiuQu4eK5BZpVX9tq+Ax/duXfvR1944YXf05oFjbMqiIaiZDMJtOWBkChM0JId27YT7xtgxfKFREMKqSVgIkQ+NW95uWT1Sq677IoFXL56Pj3t7Vi2wLYiWIZJcjCHFSkjUlWPFR5YmfV5pFgfJIecxQr3uEYwMvGiECe6Xp3gpjYDDImhJit+mih6hsq90BjphDbedzHZNKwjNxdFflAFAnWSKHDE1hP5m38jZ8fVqokTx2dDaSabT6OsTeRFIhON202XMOJscyPTK3CZKKuZWHznZFaRv942TkMbLoTx7Hjip0NMzCWvxPSzg4nFJ9czNYHadLGe04sx3Ue+/2w5zXqbT7Peuzl3hMLNZ7sBJUqUKFGixGQpCdRKlChRYnQ2MnHh0saZa0ZRJpJq8GvkgwEzEbwar8yWMT7fzNgii/lM3XFoMmwg386vTmKfoVmTGykFWt4sxJhY0OETnBnXrhJ5mouse/lMNYLpd0cci/vJ940PMHGXvvnAdiaePmUkF0LAvESJEucVHug0CKfwXg7/ryWQxCCL0ApfSHQh/Vzemcwrs0jdYcO3FBl8MSxOEDrv9BUEyo0UifZjtwfDgf9183Xz71i8tIlXXt1Lx9H0bYFQhQ+FdGdFXGSGRDqnZjdTGGpYBHIyGoUnPUxpgBIILamvCi1TvoN2NIYBmayDVgbrrriSsmgFphkilUwBksqKGm648irKZg3y7W98hcFkF80LayEXpypWQSaVwJIC33Ug4AGSdAZ27t6fO9Ka+u9khpf6M2y75Y4rt9alNVrbeCKHFiDxgCy213eCyGikWE24GaozHo6nkFqBdsAZBJUX3QVdSVNikDLXISglNkGiZhA8iwWNZS8/+fDRS449e3j7ojnUx2yIRkwWLZ9D1fKFXDo3Q9+Kno91Hcl0v/US8y/b/Vn/MaANCEaosCWB+GECwuPAIe+z26r3vv/mO9fSGd/y+J5dg8sWL4p4GVdjhEwclUXJAH1xh5tumf/EIz8+9BeWfO0vP/Thdcuryre8uH9P23suWjj3NW2myfoZ4gN91DXUsWAhnYbBwn/48tb/e/PNgT+5+57GT7y09ci7tu/c93da8dnv/uD1X7v51sgiO+BYZhl1iXi6e8/AwfpcEswG8GN0D2Sp80zfev75rTy1Jbd/3z4+29Z96ONXX80fX760fK4lU96/f2XX52c18ul5sTKMMHi5OFIrpJ93Udu5c2DZH/0R37rrhpXLDxxsZ/Ojhz/zjnfP+0V/zsGwDLJWFqWzGDqfLvbI0Yx52508fufbb+TZp7ZyrJe/CFaazA+AGS7fGS2v3amdHDKliOTSdO15+i/ecW3g99c0LQYP9jx3jANvHMPpgkAAOnrpOtbGZbfcvPKY6rKoVWHwTSKmQ9JM05DOkpU2SuYdALXhgSFRZv6+mR2RWI4ils1iewoMF6HB8iVKOpS7aaTvENESS9v4Ocj6Htdeft3DEct/+LGfPndFWZjLIyHW1lbzvkuXzQ7UVldiFNLNOo5HpKyCgfQgQipWL5/FU794mMpAhJtuXMtVKxpw0/30d/WgfEUgEGDt2nUMDAxwqPU1hDDx3BzRsCBoKCzSSw2RxBc5kBk0LlIVwqRao0fc5VprorFKugeSzF20PPn6rt1P3nC1datyNb5WCKGxTcnixfNZunoJTz7d8i8HDw5SUREklU6jfYVlKrQw0eQFf339/SxdtpDGebPA9/EcE1AIoZBa0zinlgMH9uNmkri5HJ6C2spahNR0d3bh+5JwKEwoEsa07UV+zsc/IS1nvu/Mp8b0MMiRd1QzUZgfRBhPAvuG+smTOdlBbiYFayPdu44LhAuOY2NK7s5JRzI5xusSM8xEBQLFnK9Ph9FiYjeSH7dNduw1NClpExNrYwUzEzuLkW//+hHtOMRwDKx1EmW1cObFZ60T3G4qsbyh73eqoshi3/NEvtfzYby+g4mdp7GO93w4xnOZFsafgD+VOPx0CoOnck9u4vTTZG6aQr1DqYfPZVrPdgNKlChRokSJ0SgJ1EqUKHHWCIfDM1p+Op2eyu6tTMxF7Wy5p21i/KDVy5z+LChCodB4mzQXWXeIsQe3LRR3AdoA3D9e/ZlMpuj6SbCJfFtbmLjoo4J8OoJm8u09G7N1S5w5Whj/2vgBJcHiucS5ck82M4pocbz+q0j/t4l8f7WZybliDqVPWc/Ez810PryZCUqpVUqUuNDQaX7nHWswxSC+AE+BxiRghpDaRGcGuP7yxRjaI2uE8IVJKBRAqAyPfrvlyrfcXPNwf3JgxTvve+dfDHoW8VSG6qoq3EwSlezhuZ/+IlKnD/3nwiWVvzF7wVxqGhtpjyfo7+/+r5vees/jqCBOOnVCirORAg0l4LUD+/AMyBngS1UQUihMDaZSdB44hKlGl1MooVARE9cXCNcmYtv09WTKhJ8GYSCERAiDqpo6pGmTdR2koxjykUml4qBtls+N8sy3HuKKNau4qH4WOIN4zgCWymCicB0FwseXJgfbBnni6dTv3HjbZQ96wmRg+3Z+8eRLKMx8+41CGkVtonWIClmGomP4K9H6uCjF93xuqIvgCyu/ThloVRAVKk0sGaDm6SepSQgCfhpbOQSVxiizeXLf0YbGGF9aHF0YLUsGCWiD3ngnb3z3EGve6rH4HTVcu7SSiJn53Dcf8UJvf1vDnyapJq1cyoJhku3zmFUWxjYzrT9+7PEPNC7Z85Vbb519UW/3sRe27Wh/273vvak96wnsslA+NZ8ykNRzzfI5/2fz/zy7dSC5669ue9s1lz8TffnV13a1fbm3m/8sK6PP81mY7jnaEK6kKRhDR8LoAwdzg42LuipvuX323ERf/AFLO38otRfsS6eY11RPdSxdE1Uht668gZ7OHlwpSVtU+dKzgramtyvD2rXlZSuvENso9+YFw5JE+yBvvEqipgaVHOAPk7kEiY5EayJHp+uxX/tUac2Hb7tTfnze7Fpaduzf9uQvU3/+3t+68yfaiOAoj77+XrSaT6w8SLy/nf95ZO/spZfww3vuuXzR4dYOfvSz9AduvGf1oQxlLMpogqEKpCupCAfB6+eZx7f/v+Yr+NOrLl0GHXU8/b2XOLzfpTy4mLCvcAcGmeWJSOZo1xc79uy8v3ZObUfCUVi+BCnRVpDFHT0krCBiKB1sYRGyIMR5/RCGOorwbFyl0fhopcjp/PZPbX0KhItBQbpTuNcMDTkL3vLu5Vur5ka2xruO/vv2rceenDOHB5vm1WFph3QmQyo1iNY+ImSSSHVySeN8Mj372fnSHj5437sY6DtKJFBGWbSCXC6HaRqkkhnQkvnzFtDbtw9DwEBXP3XRSmJBymwy5JBEIhFQGlQhj6nWBZWrBG3iC5NoXSUhKTFEAy+9unvXoWPHbm28fAW5jIPUBpaMYAkf7SguXbKabPI5wlYAQ2gwTTzfJBSKEqus5+lf/ZJAUFBdV07OdSiLVBONRvE8l0yuD6EcQqEA8+bOpr9nkP7uDBVldWST+f6lLFhHyk8itSRWHsSw/Ituu+UOBl2BVgLbDpBOZQmHoygfwgGfw288w5atR9bXzBKfckVgmWGHmyoqqgjbJrlMlu6OzhP6rJMFaie/H6WXG2f96IItY2hvceJWAkDL4+vHLk8V3o1X/+Tad3K9p7iLDQnkCil6pSouSFOyeP1jpdccs/7zbf8xfhvziLx734hr7BQRePHyW4vXfpyxxkHN4XC4ZYJljGSsSZsbyY8Bj8fEJhBfo7D9aoZjbavJx5vGGpdNt3gnRr7dJ9c3n3xsdH2hbRMVsmws/H8/E4+1nS4DhXpaJ7BtM1MTzlWQP7bj8dYZiG9PZMxebDzcMk3tmCoTvVbGOt5zPSZxPrCZ8Z9tNHN6ArVi+xwXvY28P4bGFSeJ3jcwtawv8zk9YfB01LsxHA5vnEIZ4zLB34+xKGV/KVGiRIkS5yQlgVqJEiXORWLkB0cnD7Y3c2b/sN7I+IO4jTPfjFPYwPjtGmByQoTJ0kTxQEFLkXWbybdvrADVVOzFT5cd5I+phckFQO4mPwDeMO0tKnGusImJiUE3zHhLSpTIM/TgYjOTC6zfWNineQbadDaY6YccJUqUONMIB1PECYge0BJtGKBt/FwCdICgJUFpfCHwNbjCQyhF2PRpuoirL1k+iyUraj/zqy2ba3a3er9/+53Xa5GKY7lZtjzz/MJLm/hp8yUXXVRbGaGstoKc6bBvzyt0d7lfSQx0E6toQOKNTCuGOOGdJC+BkPhC4RigpAcotFKF1KAKLcYSqEHCyWJjUx4IkU3HiUaosQMCU4LWCssMgDTxlUIpgdQOQwIZ0Cg3R3W1zWXzwxiJVqQTwfezaDcFKofn+SjlEg7F2LJzDy/vSv3smrcsejBngI/EwzzuSmT4ElPZI1roIfSJQ4ehFJ/6pNSNJz9cUlpT5YaozyjqUiFsV2KqIOWhCAdfP2otL5/79JXX3njR7Jo5kHPxsw6Zij76Bo/y+ENPkQse5ZL3X8b1sRC+3v8nj7U8sSgL779s3ZXZCruKaCTLzx77+fqyGHPsIP+++ZHB2Pq77C/+7u/efPlTT23f89STv/jTdJav3vX2qzJa+/i+Cb7Ht7671bSCPPXoY+nvd3U9u/TKK+rD9XOcj+Poj1eW1eaqK+YEAkGDQFmSYLmNYVXhCYkSGSBNbf0ycJ152nEL4gqJ7/lgYtmBANVm5dD3Y6ElKANcA1SgDsPFN3tIZgZgqcEtN4UqyVmfcV0XV2dwcTnU1kUqZ2ZTSTPoOCkisTR793amX9/J9xIuT/3jvz0W/OAHrs3W11XgZwdIJT2+/Y0toYoYv73+ruDfrLvm4rI3dr/K97+V+0MXHmx5esfvO4qj77zrhs2peCd+NseTP3wlOGc2//3+X4+9q2luCCsa47l/20nvSya3XfkusoM+hnaomRsgfaQjUjv4xr17k51rdIe/vNIOuKZSKKmIWA51aYeQRV6gxpCcx0KIvPOXITR5h640Wmm0Vie48OUFQiMEKCNuL19orHAD/dksZriWlWvMr2/Zcfh9ZaHIbY31VQgNvsjiKDBsAa6DO3AUmTzKkvmSzOAxTFlBMjlAKBTGsmw8z8fzPBzHAe0QiYRRThbP07jpNCGDmvKwyYBh4kmJ8A2Ekgw5jx2/7rWHkvn7XUlQwsAXHFdzaUCJfN+AFggUQssRgh2FlCZaSwJ2hIF4iv7+ASpiEQJBA88V+PmtyKf4NFHCQysP2zZwXTBEMO/uJtRxoY5hBPMvhALhLfrudx4x7rpnvW+YBmZAIJTBIz/4Vnky5V07q1reVhlQd95649zF8ZzNa/uPfbCyqmzAkgbaA0uapyFImz6UGBYkneCgNqIJJwqU5AiBGIwvPpthdOG6KboNx8Vsb0aKXU8CMdWUrBN1/2maUi0ncj9jj8VGpvo8nZhcy4j/NwMHx9iumekVIj1A8dhHRaG+JiZ+XBsLSzPD49Ch/5uYvDhkgOHvegd5QdrQhNOJsmGSdY7GxxmePHa2aBrj8wHOHYHaRCeVNc1kI97ktExgm6bTLHtDkXWjCmiHfgtG/iZorTeeZv0j2Uj+npxMnzsdzx7uL9SMoW3jAAAgAElEQVTbepr7j3ePtEygjLF+i4qZB5QoUaJEiRJnlZJArUSJEucSMYbTUY724Pmz5P+43sjULJgnSvMEtmnizDqorSZ/HsZjAzPbruZx1o9ncV1sBtd8zvx5hdObffo1zryYrsSZYwMTE4Nu4Nxx7JpJmie5/UaK91dvYWqB0zd7oGWyfdaTTC7d8yGmNpu0RIkSJSaNZygsDbavkK4ApZBmAF+YOK6H41sooXC1j48HUjOQ7sO3qY9nOlm5eDHW5Zd8NMCrb3ml5elPX3vtyu9te3Fn5ZIGtr3l6rUV82JVGMLHw8d3fCxD4CaorSmPAD6edk6QGIwUqEltYvkSjcSVYBSEOwivIEyj8HpEatKTmDO7kcHeQXLZDDu3PS/nNxjzouEQGArf8wiFIzi+xPcUvu9RWRnLp+griB8s06Knv5PunnZWrV75/7P35tF1XPed5+feWt4OPOwguIE7KYqL9tUi7HhJnMWy3UlPenra1HS6J9Nn+kSd7klmOSdNz0zOzOQkJ/bM9KRnOt2mptNJnNiJktiWVwmyLcmiNkqiKJHiAoIkiB3v4a213Tt/1HskCAIPCwGQkutzDgjiVdW9t6puXeD+6nu/PxyvTOBXcP0qQVDGtH0wDS6PFjh5qvTunXev/1TeKSCBXM4JxREN0uLVBWlXf55HmDYXnoSCDVYcLBMMBaOyxIjh/Gf7Nm7bvrGljcLkCK5bxVVFTMMHt8T6NLzwbdj5gMLeafHgA1to7xK//MwPzt3zg79++dc//9k7vvf+iZO/9ZmfT/zvmzatY/Di5JG/+qvcti9/afydX/rs8d/ZtnXDI5Y0/83gwOjvfO3oT77d3sEbGzawvr0j9tDjn2ZH2zqjq71L0tqeJBEH5bdgyBgJ2RozVCsoE4wk2BqEQAsBMo0KErgTLgKwbBvDMEFKDBROfporuSs0d7XWUsIqhGETGCl814CqS9z0iScCmjMZsJN4ToDhQAIDLAOET1dPAs9VcRWY+NpjbHKI3dvNxMcfU787NVn93fyUM3Hp0gvvnniHF6cmuKxc7t7ay88++FBPV0dHGy99/9wLP3rB+aLSHHv0Iwzf9+jGttOnRnjj2R/+9o7ebb/32stnP/nwvfzRvQ80bd28tZmp6TxDZy8z8NYE+9v7SFQVvl8ikD6+1mTiPl3NMYY8uX28VPz7fjzxJ74w8aSkYpiz0keuPJZlUA18bGnR2tlFS8r+1Osn3j+ZSh7Y09GRJnDG8b0qdjKDH2gCBa0tXbz11hlK0z5dXSl0wsB1XUzLYHo6/PPcNA20FhBYmHZA3DSpeAbtHalNf/W1F+X9n75HGWYK/AQoWRMRKdAKhJMFlZdIbVEORWLSwNA4qABqrlBahmOFlJJQaqaQuu4qFYqppDRIJBNMXhrDrTpkN7cSi8XwXDcU9NVSpSIEQggCPyBux3AqFSzjWvhWaY2QAi0USoh6ekzxS4fuD2Qxx49/9PzeYlV/PJHkZ/ZtaXpUGrRsXt9Jb3c76WQLf/u9V4LxS9Vvbt0UAwyEG2BICwNxnUuWmHW/Z48HK8VCzlxX65+132xHrcWWs2huGCsbn//N1v/hP35+LzwtzBvKmO3ItsD976exaKoea5xvbtM3b+Nu5CDhPPczC+x3gDCmdZibSwE3wMqnJp2PvkXsUxepPc7S03321/6fJbyGy3UxO8ryY8JZFo7xPF/7vlD7jrJ8EeJC9C9in/n68+2UcrC+qLdR3LSPxs5Xfdw+grsPIjfrxjff/kdoPA4uNl51kIXjTn+ziP3qwuDFxrx6WXhc/ZtF7DdTkLwcbtYJs9G9O3qTZUdERERERKwakUAtIiLidqGPcBK9kCPKZuArhEGe1XQIqwdMFuJLrG2asYWCYABfZPUDEgtN+PoXsb1RUOhx1jZdYh+L638z+TKROO3DzkKBSwjHop92odStotH437tWjViA1fgddZClpSSGUEx7eIn1DHB7C9Qu3OoGRERErDQmHmkMfMDEEJLidJ7Nm1qEkqprcPB864m3j20RuD1aakNJcrE4Z5XiVd/jLfwy+A7bN3TSkknufu+9019756W3nu/M0nn//l3Nm3rWURzPY5sSQ0ismMXu7dsYGT3+f//d1/9OJuLWNz966FG3LkIQGsQMkVkgbCzlo4WJoX0MERCgUCi0VCgVvlwPX8HfKOTRQLXi41Q9mmJJnKq7Pp2K99i2iSEUAWCZMdzAIwgUvu9x+fLlsDQdClzGxye4MnyZjzz2MJmmJFVnGi+o4AUOXuCQshMEKsFLr7zF2BQ/21FVxJIpME3S6VA4s1oEEqomlGwwajoE3zLI59jjCc3Q+Qu0tTRjGBpDuuA7SM/DFmmEW+TtN6fY3ZmmbHl0dDbxy585uPWO7Ve++8P+k1/v3cIvPnB3B52drazrbG1/9ZVXv/yRvoef+KM/fvH85s0TT338UR566MGmro88mPpCS0vLF7o3tJNoT4IqgCxTnB4kkTQIVIC2Jb5fpVAawy8F6CCBH1QRhs9kYRTH83CcANdRdLR3MTmVY2Qox9QUJJPQ056iKW5Q9KbRlwfRQmEpiVA2I8NVclMBTck0W7Z0kGwqc3lshIKGlrYEWStFzDZJxiV2TFJxiqRSNs3NGdKpDLbsRAtTiA6B3izQymizDfvRyYnco5OTRcaGKzjlCrnpIZ79/tBLo5c5/PjjHWdOnBw7+kuf2t3W3CrY0dXG1Jnj//MPv3P2/l/6TOrzDz+yE8xxCoUCycwGzr6cQ7kJmowU3uQIrZkEjrQpTU1RHruC60wjpcLD3+tJicLEFyaONGsOX6uD0BB4HrGkhedVuDySQztF8lV+9sXj7134xV84hHJHCbSL55uYpkWl7JBt7uDggRQvvHCMzZtG6V63Dq0EruviOA7pdJrm5mYs00AKGxUEKAJs28SyRE8yxXrbjl80jDRoOxTF6FB4qvEAFQP9HXTwlZiq/lkoPbOwNM1SBRD4BCpAmqClmlelI6RAGpJKuYLnujQ1NRGLxfD94KoQLFAKDQTo0HlOBdi2jed6NeFbKCINVIAprw/nCvC++TfHfrOri89u6kk/mmlKsGfvLvzAo70jSzoeI2WYnDl7mdz41Om+Rw6O2KkEualpTGViGkYohL0ph6+V6R8LpYqclwXbP9cYuLqiy4jFc5MCuWZginB+MDBrWy8Lz2l6aRz/6619HWRpc7Bm4K+55mKzlLhBP9fiamu1GG6xc78DhOfyNNdf74HaVy9zz8ezhNfwZtNrfoUwXli/pnNdn/7a94NcLwCZq10z+SLX+sLjhPdvPg5wzeVusdQzg/Q12Ce/iHIaHX9k8c25aRplx6jzG7Wv5+fYtpi+8CQfHhf425VeFt9vDrO4saKebWShca9vge1PcE1o9STwhw32/QyLz76z0LucpdR7iOvH7MWwmHbO9czMptF5rOV7lYiIiIiIiCURCdQiIiJuBw4TBhiWQv2P/z5WJ1jzJIubcB0gbP/RVWjDcnieFQpGLJDSo5FQ7nkWvidP0/ieHxZCrNVE6vACbZmLmRPViJ9evszttTo14hprKazqa7BtpcWLhwmDTEt5MbIa49XzrM0q5l7mF4oOrEH9ERERa0ocT3UT0EpJ2gihoKXEj0++K7ZttP/VXXet/5cHtnUREy4SH+V7TE6OMTU9feHdU4zqYlVnEnFhmwamqpDdv5Xdm1oPGaaBFUuRz+exYnGqnkclPw1SUy5Os21jd0/aLv/V4KXJS6/95LlvEyoWbKGpFgpMWxbvlsu88elfOvSaCKbxXUkikUCJAEe7BEKhNfgCfDQSDTWnMXnd39OSStklFkvgelWas8bBeELielVsM4bAolAooI0w7aaUBiMjYRbBulOM4zgcvOtOkkkL3y/j+RV8v0ogHOxUCm208OrrZzlxWv3Thz9y/6C2XFTgozGxZZgqtOa2dIM70lzcuM/c4o/6XsoQOAYIAb6EinIIUvZzU6XCf9/d1MzFCwPYqopFEUMrYiJFc2Y95dKZE3/3ncF/f6LCv9x1f9uGzjbo7mhn08d3s3OL8Xml8mTTMU6/9y5vnyjR2sZj58+/+Nx/eZh7t2xNJDZ0W1hAqr0Lyi6YE2CVoOoyNZxjelpRLpUZGa8QT0KxAoGCTArGR8uUSlUqTpXuDbBzZzdGpUqLnaFSCThxKocdE+QqGuJNTJRjpOKCAwe3krcrdHev5+XvHGPkvSLWlEWzEyPT1cqp48PsfrSHdb0J1vmKVCLF6RPvkZvQOD6kM7B/fw8DQ0OU3VE8D3wHetZ109XRgjSgpaUJ36vQ3pKivTvFzr1VnOkxJsZc7tzj3D+d4/VjPxl71fTZ/MJ332PPPkEmk+IXPrXd/tgj3uc3bGnHsAVXrgQMXPE49s6JS7m3+cOOCZ6oNI3dGeTytMR6yQ05OBWXuCkoBx4iZiJd+7lAhHfcM0IBYt3B6KqTVq1/hD+rqykameG0d90zMGt+ObM3CaHRgY/jOAgUViJNS2cnyXTT4DtvnfknLx9/99/dvbcFS1TwfY+YbWPbNioQNDdneOSRBzl37jyDgwNXS+7o6MCwAjRV/EChAsLUm1Lh42OZmkqFg1KaF+OxNAaiJjAVgMALAgxTjEipr6Sb4n/63us/OTwxUf3jj/3sx/4yJvCl8lA6QKExrp6bAqFob2sHYGRkhPaOVrTSCFPg+R6dnZ2cPfcuSoVOiVJaaK0JXA8pwtSgCrDMcEzoWd9DLBZD6wCtQSlFoVDAq1ZIZzJ4VQfbZONjh4w/2LhpPd1dPWTSWTy39nQqiVfyyesSU1M5clPBsW4voDqdQ0iNUBa6rg6a6Ro2+/lfrnBskdSvYL2fzXZIaywmq4nPGjhEhuK12ee0BIHafPsut4yligGXUs8HEc2NfS6kH/jXixRYb2Z588DNLC5TwXKpt2sxC07r1NvzPDcn6FotmrlxnvZFwnnnEVb3etbrP8T81+bIjO+LvX55ro+nPk240KvRwsUDLM3drp4Z5GiDfRYTQ+ib5/OnWNt58nEWf32X248/w9KenYilsxpj4KLHvQbvH94EjtZF+lwTvTV65laiv8x+RhdT77zjkVJz/v7619TOr0GZN+N+99Qij4+IiIiIiLglRAK1iIiIW81Blr+i4wBhwKBvxVoTkmVpzlhfqrXjVv/hf4GlpW9bLgvVsRjBTo7QKnu+SeMB1ibN51EW55JVJ0/Y3yLHrIjniRz0bgcapTs5yNo8q71rUAeEv2t+Ywn75wnH6/5l1tfP/EHkAdZmZfaTLG2MjoiI+EBj4uksCB+QSFnFFj6tXW1KyuqR0StDV6ayxu/fsbmL9Z1NCN8ldud2CsXy5t07Rja//vZpzpy9wNbNPTjVIs2pGNlUO66CoiPwArBNC8u08KSD55YROqClKU5nazd37du7wTD9XwN1VRjhui6jo6OUy2XOn3rtzctni//Hxt1b/kPOyaOliTBCwUPoqgQgr0tDdr0jjMSykpga4raBafKJpuYk0lAEAZhGPJS3KR/DkNiGwe4dOxFCIg2JEBopBIoAp1ygXJ3G96sI6RFPxYinmjhxZorX3x355oN99/y7WCpFuRqK0wjCFKF1FiNOWw6GDmvxJPgGxOMJsqnM986fvfRXcdP4XLMwiAdVkqoMwHjZYUJ7iELwzw8c2N7/k1Nn/u2Pz048ce9enti97cp9bdkkybgkXyrxt996n1gMNm+Ghx7t2JrKpLeaFsRjGsPM43plJoZPMpFzmchBpQwtzVAqgvKSBMpgXc9mSsUJNqwz6chuYHhA4HhNBLkShpNnQ28rasJn/30Po6TFt374KuWWFk5ccik5cSbfc9i5Ps47Zy/ipm3u+9g9vPSDl7h4rEhmOsVGcwPCMRg9maN7yzqunCtw18/so6upmbdPnmPK2kGhOUC7Dtp0GZyy2b5lH05lCKfi4JeayY2WGRk4j21LUmlJoMskk4p0E6zbkCCeMOnZvgFK2nBLXubeB7o+Ojk4xWuvnOXsuxrDKNLWdobOng7eP3uaU6cLXLjIK2PjfMXz+Mq+9t5qUV18/f1T7z23vSfLmfdPUS3FSSRSTOQmmQqqXK7k/qq9d9N33aID+Ih6D59L4LPSiLqLmCRXrmLEM2w/cMcfv/bOycc7m/XPb9/USqAVExM5Usk0hmFjmTaGIbhj747ritI6dCLz/CpChc9PmJM1AAGtbc1YRunj2ufvcrkpqk4RX0EohFG0tmbxfJepqeL/tKO36x/ddceWT164cO6Tb/zkx+/GDATKQymF0oAUaB2E/695zW3atJlLlwewLRvH8TAB3/OwE2myTc1IXUX7CtOQUHNGw1Dh864FlmWRz+cRMkEqlaBYmg7PKQhHm2QqhWkaDF68SHPW4lM/+1GKxSlKpQpTOZ90Kgs6DPtqoQiUR65UIBC8pw2LQFZBS5QWYbuFiZDXXqLe8MJY3ty917UXtGJWOTe8lhZzf17XPV4dv5Y4jum6O2b9OC3nqLzB8XrW8TfQuD03HL9Ex7Abzn+JLNz+W3f8Aosjf9pjL41EPSt9bS5weztorzZzXc9+Vn4+upAYaDH3db647JElt+bm6Of2FFBGfDjon+Ozp1n9lMcDa1TvARo7sy13LMgTxasjIiIiIm5zIoFaRMSHn6Ua5ffTeHJ5c8b7N3KUpTnBzOYQ4QT8yAq0pc6TLN22/8kVbsNyWM2UpzPpW2B7/yLLeZrGq5r6WD2XsixhO5cyuXyT8BoPLLPOviXuf4TGQauPsjYORhE3Uhf+RNx6Go15ayFQ66VxEH9gBerIEo6FS1kFWhcs38z5N7q2fTdR7lJoVM9P+8uqiIgPISaeiGNqF5tpbDVNTBcxbBPpm8WyG/+DZ74z+NWRXYUXHrln26ZtvR0oX5DOZNl/Xy8FTJ77yQmybVl61/UwfOkcmUwGzzeoaomrICYlFgHJRAzPUqSbUthWDOEnCJRC6Spa+1db1NLSzYZ1zTQ3N3Pp0vCBbPL8v39v4PyvXKzw2bYd6yoyEQ8FINqquQvVXHzqzjgzX7prqFZdcFy+8b3vxB66p/2XOzpbMM2AoOITsy2CujOVDqgnC0WDEgrDMEAoqpUyvu+QiMfwAh/Xc0F7DI+N8sOXz1+sGuKzJMuMFUeIx5rC9KCA1CYShVilMJChIO5DwgNda3pTPEZ+KkesI/v507nh3+uQsV9PeV4mHrgEQnJhuvpGOp74H//R/kf6z01coe1XPlF90zv/R0n8P/rTPxv4yMb1hae6etjSsxU23QGdLbCxuwsrnoKiQznvMzxdYLJUxhGh09f4NBg2rOuBcsmmrGxU0BI6VNkxNm7dTGd3J5dePMN737hIurqBVieLVGkun77IOEVkvo2JZotXLno889YUV4KNpLv2MRn3eenUaR5sNUmeKRDvyDF12iJ2ej2t5U429GxClyv475coTVWpWgZDl10GTg/w1WePc4KtlO1OYtUpjOIEe7rG+Xx6Ow/fs53yyBiTF00qmFQrJm5VYSpFU2sG7eUZGYLT71Voa4XOFgdTJmlta4F4ldbNNp9o7eHK8BCXr8DYOFyeHOO145wvFvlHj/Xt+/EdW1MMvXqe1nGbPTsO9g+9df7T7w9N/27MNu9K2A6XRq8QaKMwVCz829T29b9V9DxMqbBUKFDzMRF6iY5PS0ZRd0nSAjwt8Q2LVFsblVMnP/vqa5fOxrTeuHHjeqT0KFdKWFaVQJkYhomUJiBrTlMSrXUo6FJB6Imm7DBtr1AgIJNJ09tr/Urgq9/IZluIxzWWUjZaumCRm8yTSTfT1tx+dvTy1GBq//ZNd9+xk4P33L3nO995Bo1fE93IqwKbUHslQfhs27aNS5cHKBQLxGNJhApQysMyBC3NWdxgFKElQgVoGeD7LlLamKaBUgbFYhHf8+nqbEXrILxEQqEJAIUwTIaGhymUiuzYtQslUmBo4k0a0zDwggDwr15TJ/AYyo1TlbxD3MTzw2uudOiqeJMpFj+ELM5BMmLVWWhx408zKx3/O85Pt0BtLgZuQZ0LzXN7mTuWudbuaRDGdVfbLS/ip5fsHJ8NrHUjavSz9n29f4HtB5l7zP4St95EISIiIiIioiGRQC0iIuJWcpiVWX3yJCv3x3cvy5twPEkoIBhYgTYshydYu5f1jYQ5F5bQjv5F1HN0kWUthYOEQZSlBN7+hrC/RhO8CFi91MIRS6ef+UXVqzWGzKSvwbY8N/874SDhOSxVTNvHzffRRmP5ZtbG5bKvwbbVrjsiImJZzHBY0jM+E3WRhH/t66rYxQRhAzZSS4QGAxdTlzD8HLaqIlWQsU3xz2Jt8sD5wamYcl9lutBLPCEpuWWMdDOJZBLbhud/9ALZT3yEeKKJ6UIZzDhWPE0ik8TSAuUHCC2xrBhu1cGwbJTSTE/laGpOMlOUUMhPUSmV8N0y2XScx+7fT2/vxKe+/uwbL6V8fbDqSQwpCYTEUCC1qol4aqKwGddFaJ+EaaN1QCbNPsv0urNNSagWERhYhoWQCiUIhS9BAMTQgFSawKvi4FKYnkQaEiUtmprbKJYTVCplnv3huYu+xUMHHrjHG508Q3tnFqdUBm0jNYCPb7k18dvy0DNSN878WWtNNeZTSAgcYVExNIGE8eJlkm1JCm6FVFvit05dGvy9mMm9MUEyEAxu/+RdrwbFEiP6CmWrxFTVI9m0nnbb4I49A//4oQdbe7q6LJKtzQgzoFwa5+LQCM4ElCchE4fhESiUQKRg/d5WDvZtIZE2OT9a5K+/f4pLYwH5iTzVyjTWi/DoAYtP35tk6FyJ4Bysb+qkJ7mFwPM4eS6PlEXOHB+isq2VM+cmyKkmWvZ+ikvFJnSngedrXjk3QG9ridePvUv8sk9iOMV9O+8nVvFR1RLp5p18+71nmehUiIEmRqYKvDsKZ7IdBIleEqIdqg7B0AA9bw2ya3MLx39wjnMvQXvMIi4zlJ0ylZaAh371IeSdFkye5cTbA4yPw/uvuiQsl5ZMjkQcUllIpCGWSrPtjgxbtGZ6WtDSYva8dvzKr5Xc2I9VYBNPZpFYVBD0fnL/M2XXe+aFl164N6iyKZmgPF3k1Y4dXePDsRJK+iTsAFMrBD5Vw6aU8HCld/X+X2d6JK5KKq/1+tkpGmcJoGa6DTomBIaLkn7o6iUglUxSLFcJKgUO3vuA9+b3X37oncTwS/F4x8aWtjYCv4AKylQrJWzbxjTiSBGGOa+JrSQaASp0y1JCImvbspkm1ne1d//g+z/6ne6e5g1tWWOfocQmMCfR8vzERPWFt9+a/MGePfarpYr7/05NjP4vvdu6sZIWbdk0aPfaqWlQhO6PoJBa0dbSQktTC6NXxti1cyd+4IOGwC9jSoXv19LtaglaI1EEgYcW4TM6MTlBLBajq7uDQjFPPcWV7/sgFI5T4b1TJ0k1pdiyZSuT40UymQyGUDhuBcM2qFaLmHZ4Z3wlyeVdlOY1bcQIArN+iSCouVjNuKkLuFotnVr7Z5crZ1Wj5vu8dlOvpY2d9X2B9qq6WFcsbv/rOih1XzyQsxs2z/431H/D8Uu5vhJVs/act/4FUGqB9t/C4w0CYhqkLs59LHwpwP5MIG671xgXat9vlairf4XLW2gR6Yed+VLlrTX9C2w/PMdnt8ox6Ti3bxraiA8+vXN8NpdobaVZizoWQ/8C2+d65i+w/ExFERERERERa8ZtN7OLiIhYOUqlUsPtqVTqpsovl8sNtyeTyYWKONJgW/0P6uOEE4PHmd9WvZlwgr4Sf4A3alMjmmvHHq5/sIjzXymeYvVFGHV6aRx866//ZxH9Y4DG6fk+Q3jv5xRZLPP61gUrS3HIe4o5AkALnd/NcrP9Z7Xb91PMv+CnwLnpZvvPavffGeU3uhcNx5BGJBKJxe56uMG2edu2yPL7CF8S3PR4tUz6F9h+mHl+Z1YqlYYHLvL8H6fxufcvppCIiIi1QdX+/ef/zX8NWl4TmmmFxEWKKkKU6erJYFEkrqYxcEGbBDpNVbTi6Sy/fvgfMDUxQsYsoMqXiOkxfvidv/xcyubfbOhOdHd2rkPgI/Gp6BKVskJJhShOUZkcZWNXEyNXpun/4QvcffdBDDONFAYmGjNwQVoY0kBhIrVJOplBEkdaJu0dzWgdhE5FInRyCpRHMh0jCFwcxyUlAu7o3UjlPv/A0999++gnPvv4YZVIU/Jd7IRBrruFfH6SZKKJVCpDtVrFNCWVUp5MMsuG7i5K0+MkYtyVbdJoVUEqjWHYSCGwpYmPQxB4uJ5P4GridgLD0Lh+CYwizRkNZgwlEoxMOLx/doSXXxl7esLlifUHE7nTQ2+DcBm/nMPQoaNUXUjWtDlW+3nlnYCsQOJ4Pr5SYUZRwNIGrqhgCfB1hcT9qXFD8W1QGMBpeRpDwbBy8YTNuZOvYVgWxy5O7vvYQ/Ev7Nu2jun8MDonuDg8Ta5aRggojMHuTQJRtelOZmgpxZkcrTCYL1EZHWL3gY28eHycv367icnkDnQsiTCrjJ05xpgZo1i+zNaJBE1uJz1BO0lHI2WcNr+TCS/P1FgBt1WT1QbBWJELp0YopZLgTmOXirSkoS3TQtaOYRs+Wha4fO5ttsZ7KExMcrl0hUQ2RmdzQCE3wWDJYsJsRhlJtE6gjQxWusLoyAAVJ8UPvnEGfQp6nVY2sxXKkosjA3iZPMf+9k3uSW7n7aEpTg/GcP0UdmecdFOClHaxZIFTl3N4Jsh4kaZUlV09PXR3bqApYcWGR8pf+N4PX/2DjZvb3i5V8ljKxIrJUMEVA30o+aqBfjUPCGEwIiooQ6N1QEFpqDkKKlw6tqVRtfR8WtwoNJr982xBoxCzFGviWj/UQnFi8ARKXHNQA1UTmkninmTrzi2XL126uH8qf+Ird+zqeXxrbxupeAIrJvFcD6dSJp6IU3KmiCVstNYIYhgiA8Ko9XtVc3x8D04AACAASURBVFiDixcv4hRy+qP3NH9x647tZFvaqVZdXNfvAe6cnJj4xXvuzXP63cvfGx5iYrR4hfW6HfwKmzb18OIP32bPHVXau3rIT5ewjThQF4BqfMdl5/YdnDv3PvncJOlUBqU98vnLpJKaZLKJekphoRQahQ48Aq0BTeAqNm3ciA5CYWo6laJQCP9GjsViXBkZIvADHnzoXirVKql4CuUppCGwpIHER3kO04UizU0djA5No3z7ve7ulqHBCxfxCO+toUoYCoQUzJQZSjFboLU8cWu9HKVnKxZr3eBqHwi/X21B7T6JmqBJMKs/Xf25XkL9yOvHt6v1LygIm+WYJhZq/9z731DqvMfPlnQucPwyhWHXjp/7+t8Ox9s4/JNf3humpJ4DR6T7/8NfvPCU0uZKp1q8WZ4kXDTTz81lhlgOzy9l50UKTo8SzvFuldioLrJ6mqU7iK8Ezdzowr7WQpULNF6IlWVuUcoRbt0iysOE12ytn4GIDz+HgKxSambfXotn8gA3LsjsW4N6Z/LmAtt7mfs92WGiBdURERERER8AIoFaRETErWI+G2KY263qacKgz1fmOabuonYz9DK/CA7CANBAg32+wDVR3VrxJisnRlgMC6U1fHqJ5R0F/nCB+o4uscz5OMLS3fGeWMH6Iz74PEW0Eu12o3+B7avpotZL4+B9/02U/SSNx8a5+BesfP9slE7nMKub2rrRCvA8PwVC0YiIDzYSqUNHMQOFxMfAJaaL2OSIk8NSDmDhaR90HIlNYWwQ7RbxjEliMsd3/vYv/+Dhezb85r37tmIZGsMKBVY31CYljlPBMGB6ukCpXGJiqkBHexcKgaE0CF0TNEhMYgSBwg0kaB8h9FXBjRASaiIcDBOtLQxiWDGPoFIA32fb+nU8sGfiC9/406e/+qtP/MNn3IpPwrLxrBSe5eBXPKpBKNYNfJ+YkUAqjVMc5c//49fimzfwO53tNsp3kBg1FzeBIX1QLoFXIfA1vh/DjMcwpI/nC0oVn3ylwMTUCPmS745OeM8Mj/L/HLzvwDNTTp5hdYXAcK5eF2WEApTZerR5dCI3hWdCOVb7Yak6CgEy8BAijRVoEgmGC6UgGBwLjLNncxRdn5HxIi1dWZrSgp/52b2MvX+O916+iJxQtOoMaZoYz11iaCiP4dgMXnG4MBZDbd6ITGVxihME2V0cP32SB7uSeCrA8aZ59cwrbOzuJZ8rMHB5gMQdcWJtgj13b0dlhvASij9+8cdo+32E6RH3LvPQvW10ZQx2b13PVP4CTfek6P/qiwwmmpmcyOO3QfOeJJlORffWLFOXFOr1K3il90l1mpi+TWXkLOtsSJomQUExcR7ubdvOen8dngJimteGX8EdVpSPD/PycJ6BqVaGxn0sc5rtnT7rmeCxu3fx2GMHOHnyPS6cGeXSiM95a5DNvZO0dmxkdHIqsCyGtRFQivkoca1PyNr3q929djskopYe8/q+ooTDddwgULtecLMUgRoQpqOtiZIQ6qpYDSCQNjKeYfvee3OFwuhnX3rj3M+9f27wv+puNX6uvT1hJ2yLrs6NlCsumWwrgargeVVAooUXdjKsq2cI8NJLIzS3Ivb2NLOpM0UgNelUmsAPqFTKbNq4A99x2dCT/cTrr7/DmXPjbOzN0ZxSbN++lUuDA7z48sv8/Kd/gXjCJnCC8OpphQZy+TzpdJpNGzbiVKrhAgsRuqshmJEWWKKVBgRaaVRNYNXUlCWTbkIIieu6FIpFEskEvueRy00wMDDAQw88SCoRR5ox3Ep4fVWg0Bo8v0IybtGUzoI0GBme4N2T7v/XvcXFNJOAzcy0qrMFaTc4nS35wb4eo+agNrtf1Lkhxejs+o3rj59f7zR3Oxeqf6GB68bjl3Y9Fq7/p/d4SYBgev6DNYhw7jFAOEe4HYQwz3Mt/nUY+Os1rv/oKpX7OOE8diWyXSyFPKEApD7Hq8/j11qUeITr456H17j+/gW2z9X/n+fWxqkGuOb8HjmpRaw0T3It7lQ3MFgLDs+qt2+N6q2z0PuVI3N89hTRQs6IiIiIiA8IkUAtIiLiVtE3z+d55l/tcZT5U3CuRLqxhSb0R2gsUKuX0XcTbVgqazUxW2x9/Ussb6H9V0JckiW8L0sJbOW5FpiLiIBwJeutSJkQ0ZgcjZ0Yj7B6wfsjC2xfqmC3zlGWPl4dvon6GtHP/AK1zbV6j65CvQdpHNxejXONiIi4aSQKiUSCNlGEr+8lJmHoQWIFYAiQ2gzFGdpEYmJosPBJGQ6OMUnMGuHYC1//i5/7+d2/vGvzOlJGDN+FwA/LvgEjTJGHDujoaKdNt1GtVlFKAQZCh25eQkkIJEKYGMIAW18VwiiCmpROg5ZoEdYlsDElaOUhpEG+6ICU7D24nQuTo3/x1a/+ydZf/cITY15gMzg8hhlrw5QlnFIFy7bxPEXSzjI+PMS3jj27bu8dfOvg/uyGttY4KvAQRgwpQ4Fa4Dr4qorrV3Fdk+npMqdOXWa6MDmiTTk6MOKcdDTnvIDXPcWLe/fvGUp1CFwdoxLIq+5WH0QUEItVwdFYGXtsMJd8+C+fnXzgvUvBBqPF+K14cj1dk4L1yuRr33iVLj+OHurEnEyxdcdBbM/CvSi4NDDIcLaINqFLwkR+FKfqIv0q+UsX6M3AQ7ta2IrLSyMTlF2fV06/R7atBbkuwNtQpGlHnIP3duFVLlKausI/vttisnSBZluysTVBT7LE/Tu2cOddm3i7MMKp4TO0fc4knysQt2KU4w5X7DJ370+x/9AWqt96m8/tsjg2NMzgwCUksKMd9m6GB3ZmcS+XGa/ClXfP0NqcoORJTg6fp9QNpaTNO4OKZy/HOeVlSbfvxHYqnHjnDT6xNU3nxSLFcYP8KcX63Ea22HHeHR/gG8eLf9y25d03c0WObexsGmvNdDKZm0YZoRhJhJkoWajLrHSWx0bMFKRdJ16rpfwsGxU838dOxunZseMZr5x/ZnAyv/7k+eJDCZu7Y9bU1kzavENLvzOTpmvnzhaamkwERYSIIUQTdUEYWtL32GbKVZeBgSs82z/KRz66ng2bNtPS0oaybJTnM5Wborujk1/+XC/f/Oa3GB+bJBVP4Qc+Dz/6KH/yH5/hzbfe4J577qfkVkHXnMCEIggCbNuma916hq5cuu5cwlMM/xMAoiYKDNsWiniS8RRCmGitMaRJJpNCa8XU5CRXhoe5c99eNmxaz+WhywhixKy2UOAnXQwpmZ4u0dmdJlBlLl0a5OTJIddz+T8NU+C6LtKOXX+9V0G4+oFGz3g4xMq7TkYsiyOEsZ0nubVCtdmxgacJhQFrJabKs3rzoRxhLOz8KpU/F7PFaXUOE8Zgl7rQ9Gb4DNcc3I6w9kK9ow229XLjtajHLm81A4T3sI/wukVCtYiVot7njxOO/2uVUvlW1VvnaINtfdz4++ZNoph1RERERMQHiEigFhERcavom+fzJ2lsRXyE+QNRvSxfoNZHY/v457kmVmoUeDpUK6t/nu0ryRe5OUHeUsnSOMjwPEu3kT5OGNybb6LXt8TyZtNLGFxaSlCp7koXufNEzOQIkU367cpR5ncb28zKOGzO5iCNX0BcYOljSJalr1afL5i/UhylsZPbEcIxdqWfjYXuVyRQi4i4DZH4WLqKoUFqF0NJDO1jSAepixgUsXUMAxdxNQWbrInHXExdhOplYkaOYy98/eu7tzd/bktvE8m4YnJkgmyqEzuRnlOgJqVEuhI77lMoTuF7HqZVc0uaISwQykRrEx0kCAyD5pZmlPRR0kVLn8nJKTRGTbUTfomamEVKwIzjuT6Bcsi2JLjn3t1p6+Tga//pqa/8ZrHCj1vasrn9+w9U2zuacKsGhUKBpngSQ/tcOPPWr+6/g39z970dLe3ZGKlEjErRQZo2aAslNJ7nEeChtcbxA85duDz+xhuFX42n+dGDh/Y7ftbDxSAIfAIt8HQMV/gYCGLJBDTOsHzbUjfUCaSJkkm8WIbxkjwW6OZjLw9XPlsqCRJJD3/iCv/wZ+5id8pn4twwGbcVnfexSgbeeJlN6R7GJ68gpKKzA+4OFC+fP8aVkqC1Jc3de1JstkpkzTG2P3AHFTXJxfeLdHe0ogOPeEuMrj0t7HhwC+OjZ7nv4BZaMzY7Rio4gaQtmaKUn2TLhq1s3txDtZBj38P7ae9p5+w758gYKXLTeeLJJNt6Ymy/swWqIxx6aBcpcZbWlmly1VAG2ZRU7Nme5NBdG7mUnuRS90XstOa1cz9hOhCwySS5GeQmm0uuR9m3SHbvpGR24jnT2Iluzl08zf6mFBMXitiDFmrIwZEay0jR7rnPro/t+DOrNE5PbANOwQ0dyrjNhTazhUC65jAmwDfBjlkIYeGVXWJNCQyr5bKdcr4Ws4yvbe3dTDIh+Yu/+H4sneAjiqk/371DtmWbLQh8LDsJ2q6NIZKOjjaasi10d3dgx07wve9f5sGHytx5535M06RQrCKUxvM9HMdh27ZtHD9+hp3btwNhms3P/71DPPeD51HqGLt378P3qkhpIITATsRxHId0OklTcwv6aorMcNy7mnJS1+/KNQ87tEYBrutjmRZSSibGJylXSsRiMXbt3IlpWYyNjmJZBol4AuUrfF9BzSUv8BUSi4nJMm+9eY6pKf7+nfuSRRVLMlqokpgpUGPhlK1h+26+/8yXalDU0rku9vj5tZONVZVz1z9XvTP3q5+7mnH8UtWbukH9i+en/XjCeccRrjldPU44N8syf3ysl4XFBfna94XmVUeZWzhwuNa2w4soYyEO0lh8V69rtRhY4v4z0432zfHZQnU1igMfIbyeSxVe9HFtntw/4/ODNM7oAWFseLHpRd9k4XuRZXFz/As0jiUfnfVzPRZwO8Wp+gnb1Mv1z+cA87dzMWK2xVzniOtZbL9b7rWdr/yF3O6Pz6qvj4XHvKWIVOc7n/5ZP69VvTNZ7D2pZ/CZr4zZ8bK6UDV6RiIiIiIiPjBEArWIiIhbRXaezwcWcexx5p7A9rF8YdiRBbYfnvH/Jwn/8J9vEnOUcDK+muRZewv3vgW2L1cw8DTwG/Nsaya81ssp+yBhf1jqqtqjROK0iOu5QJTq9XbmaRYnohpYwTqPLrB9qePzcserI6yuUDlH4zSfm7kmHF8pDtM4SL2ajgERERHLJHy175LS41jKxVAmhpJk4haem8eUJc6feet/E1PWxomp6SceeWy/q5XANDSe66ArU8TjSRJa0P/c03907/0bPrd9axZbelSrmnSqCV+B9gJMw7jhBbdSCtM0cd0ySimkYaC1RgiBlBJhghaSpJ1C6TSTOc2p94cYzb9PsjVF0Z1g/YZ27tp3gEqpQDqdxnEccrlJUBqhfWKmREoL04ghlCLAZeuW9XR3r9+4+3L+L0+9f9aJJcmPjf7kxOl3nedK0/ynRx45eP7E8WMbMxnzy3cfbP7s1i1pMhkIPIdC3iMRy4KMozDQWuFrH2EIpBnn0vlB3jrl/P7P/72Pfr/kuxCzqZYnCYQE0wiFM9pDCo3j5VGGw82KR2ZKNOolKdEold7K4SpJ1e/C8dvxZTPFdJog28MZVTm458F7uTR+GZVYx1MvnOS/fbiZ7piD35yjMuzxwrPfJKubmNIFqhvLyBQ8+MgGdhYN9p3KcXbIQ/gVdrbD3Ttb2LstDpXz7N3fwq4dnVRKEqeiyXbvxO5ogoxNMsigp6fZsr2HDTtDd0BDCKTeCMoGTExfoFyftg2tdKxvxcuXkdIg1pqG1hg4V0J7LGlx78cOcq+vyeenKOXHISjRc8cmyI+QTHl8/As7OXXsPFM9Hgjo2hKnZUeM1i0t8PoIF0YrfOudl8mrDpp8hzZvmHsfXoeYnEYPxrGGNYfufJj8ZIH8m2+yUTUlN3S102m2441CkChjKgtPhCIppTVChOLA+uMkZgimwmdMX5fic7auZKFuoWspP8N+pZCzj9ALi5HCI8N+qAxBNQjwNJjSwtVgxGIk7LCcMkkqFZ9P/eJjjknx+6+8+Prvp5MT/2tLdgNe4CKUj8BEYaPxEVIzNTFKLGbT19dH77ZLPPf8aWzzFDt27MAwIGbZmIZJ3I5x14EDXLl0meeff55Dhw5R9opIKfnYxw5xZWiE8bERUqkmbDv0jhQIpGlSrrrEEilE7UESNSGawbWUqAEarWouanWRngq/qyAURcVjSWQtTWIymaFSKYdXxwioVPNAgWq1CoYkk8nQ3b2RwYErvPPOheDVl/m1bdutp3MlF214tLa0UnI9EBqpNVpp9GyR1qwbrq/6Yq4OQlOzn5tvh+vHt/n733LaqOfoj7Nr0LPKXurAeLPXbpUH4oWex1voIqfnP/enWXhekGX++E49rnaUcE7Vz8295K87u60Uj8/4qs8Tn2D150KLdeT6G8LzHZj1ef9KNobF3ee5mK8ddTHjzTrwPcXiU4DWs0MsJDycjye5fo682gvVbpYBwmdrobjI7POaST11aTT3Xz5fYv54O8C/YPnvFg4DX5nj86dZemrcg8Aby2zHTJ5gabHb5cbhZvNFFn6vVOcwc1+3mTT6PXKE60Vu9bFgYJH1R0RERERE3BZEArWIiIjbjf5F7LPSK0L6aPwy/Cmu/0M/RziBm28lzWo59sxkNRxrFmKhIFX/Mss9SuMJ83IEaodZeMI3H3/INUHLl7h9Az4Ra8eRW92AiIYM0FhE1Uz4PB9cofq+RONVj3mWFhQ7XCtzOUGxtRivvkTjFeS/QTj+r0Tg+CAL/+5ca3F2RETEYtE+FtPEKSCJhX4zToAZlCjkhvY9cNfm375jz0ZeeKn/wZ+88Nb/cNd9m78qZAahNCkrTtIM+MZffvu3Dn1sy6/v3bYBQQmpDIQ2r6YOVcrHJxSj1UVquiauCLRDoDxghsOOEBjSQMpQGnNhZJjBi2XeP1di/bb97H+4jxPnTpFZt4ULYxd558+/x6EH76e1tR3HHSeRbMJXFUTggPJAaUwrhvAUnu8SqIBY3GbntnVs2NAcS2fpnMrlPjY8lPvY5ETxi8dfP/7tVIpHP9a3v6k5bRK4OZxiAdOM09O5nlI1QPkmjqcwRIDWCkNKtCnxMQlwXnNEHFeaIC08UQvhCJCEwhK0DgVkYjHeQ0tDrZ4W5Tq0BhWA8i2UiuFpSSBtRqc8kM2j42UBmTaSiRb80hAlt8yGbS1M2FNYQCKu0M4UGzY1M5Yuk9wCvT0mO3SSba3ryZcDTG2xraMbKybAKqG8KtoC04qRao2TJM7kRIGRN4fIFXIgBZ7vorWPrxRCaYSvCLSFqyyUb2L5Gq09XMtFCZ+4YaO1xk7FSKeTSNPHUGD7JlJD98Yu2rJpmpPteNMW7sUJTDtOW3cXbb0Zspu7GB0Zx/NdmrKCzg0mVibF8TfPcaAbiNvkHR/TKZEViowYp7slTfOwQWl8gumLo8R0ilavibGR4XOZXXFUXOGaLoFcC3GJ4qocLdS3zUDW9D1Lb4fUYXnXOWcJVRPUhHVqAZ4w0UIS6LBux+FV308iRRxDqhlpLCUCGyGLmLYi8DymJnLs3rWHmJ3gu999k2Qszp377qBQKFAqlwBwXZdHP/Ior7/+Ou+++y5bNvdimSaGadLV3YVWGikNDNNEGBIhBMIyCASgQ8GaBoQUtTTCdUGgDAW11BSDdXmoDh27pAy3m1YMVROwOY6DNET43GgN2qNUKpBtayZmJ3Acl7ffOs2zPxgsFIs8+c/+2SePfucHPyKWMFCWTa5cAtO+dudELSXzrUzzuUjB4orXF6Xv/DBTd6ieyy3reeYWo/Vx+whiZgqz+rjReWi1OLyIfZYizrrdyBHe++duooznWdr5P821RdVzzfufYP6Y6kGuX5D3Ycn6cJi5FxrmCWPqR9eyMR9SnuSaYOwgYRzrTcK+s1zhZ5354mtHllHWcUKxXKOFpwvxFEvvM3V3xuW+P4AwFnlkCfsfrX2fr84nmP/Zfpzr35+8ye3nohgREREREbEoIoFaRETE7UYfCwud5nNfWy4Lvew+Ms8xTzK/oOAI4aRjtSYJR1ap3Eb0Ndi2nHR2dY4TBiDmu5aLXb1Z5yiNU+8thuZaGV8gnPAdZXXvZ8Tty1LFRhG3hoVEVAcI7+Phm6znMI0FtfW2LHasWGhF62KYOV5d4JoLwEqNV/2EAfhGQu6j3PwK7sWsXr0V7qERERGLRfhoWUWJIhIXJUPHHT+YxlG5n9u8ZTdd7YJ/8Cs/s/X7L73054MjF76Yz/EjqpxtNuhUVR67Z3/TPY/ct59AVTCMBFUvqIkITJQIUyMqrfEVGDUnIaU1SiuU8gmUhwhteEJxiABpgGEI/MDHNeDM6AgPfPI/Z99n/wmfO/QLfPfHb7BxT4qf9D/DuZd+zPe/9w0uXZ7gnvv20NqRoFQdo1iYpJCfpCWRRWgDIRIYmOhavVqXSCYDCBQtmTjNu9YByHTG+XS5WOT0ybd44O77SMa7sFQG39fkJgK0EQNhoE0DtELUXKYCHQptPEnBkyaOlkhhXb3UhpIYgUAGFjLQCC3xLIlQNy/wEHo+E6MbFEfzCuLmk3tcFb/MKl8BhlbEVRlT5bDUNIZ2SWbbePHS4N+5FzP/V3NXCtwSU6PDGAeamHSn6LkHjH0gRjWVCRfRNMY9O9tp3pMGw0CVDbrS3TTHDNyqxXtvjzCZm2aiMoWLTy7nUqrAVAGKJUhaUC2HyfwSTVD2wjNWCiwFSQ/QAVWzChpiGgwBjg2uBa528FyI4ZIwC0hCjVEQZomlqkbwq9BmQk8rJOKQyFjEOkJB27pUKynboL2jneaOGEoUCSo+n/yZ/Wx69yJ3j7m4jkMgpzEtxfpNG6meLTNxYoRiGcbOXaHJ6sTJuZVkuulY1fKZTpaZTE1TTJRxA/favajZpy2UtHHp2fgUSoQ9o96PlA77ihDimkvbUhACqQ0sLTCUQiIwtap9gYnGExLPdEMXsMDG0FAuU/TdOKbIYttmTeSmQEmU8jAkpJuSKJ1kuuDQ//1n2bBpI/v2ttPfP0AsZtHR0UEsFsMPfCzDwPM8Hn7gQV5//XVyU1Ok02mkaROPxzEMA5AY0kIhQ/fBq/Z0EoRAi9pTJCTSCB3UhJagBEoFaKGR0qw5QAZX0yFLKdAywCJ0YFTKC4VVdY2bkLS2d1Aql3nn3ROcPXMZ34Ptu4TZ3d3zr374wnP/XaHgPZ0v89vx5piWIl67W9fQOkxCaiBQ+gY/tdU0T7u9qAvW1lowF7HS1MVpcy0saiSu6uP2EajNpH+N6ull4fSWdQHRB5l+4Mssby6eZ3lxhePcKFK7wDUR0VxkZ237MmE8+IMem3ycuQU69VSF/Wvamg83/azO9eyb47PZC/yXwpcI7/1iUr7Opv4cLYejtXoXm9Z3JssdC47Wvs98Bt4kPIf+eY7p5frY9FJc2yIiIiIiIm47IoFaRETE7UYfjSdOWeafrCxngn6Yxk44802ucjReZdNc235kGW1aiDfnadNqcpC5V53W6b/J8p9mflFZc63+xQgf+lneZLYRBwhXcf0hYX+42VVmER8sonv9waCfhUVUXyD8HXKY5f2+OML8zpl1liKgeprlBcEasZlr49XfEAawVqIPH6HxCvNmwnuw3JXOi02tsBTxX0RExC1A4CHxQ2GYhnjMpOSWSWXoDPwCMTtDpZzn4J17uOMOsWtqanqXjUnGshg8cw7HrVAq5sg2N6OlALfKVRlUzf1Ia41SNZchEToMCQkChQ6C69pjmmbNfUgRIFm3qYdNkwET02NQLvFf/No/xU19nYGxi4zlBXd99OOI6gR/+uf/gao7SVNW0tGVoqcnTWdrC9PjeXwPTGEhbRPLVyjpoFU1dDATkiDQeNUyrldl765tlEtV3j7+Dj9+/iW2bN7Izq27Sbe3Mz45QSB9lFAo6aK0i1IuYBEIkwCbQDClkUgVCsfmdjeS4Zc2kSqO5V+TnAhZc5lT1x+o9dySpLqwKHSoMtEkEFohRQmBX0sBWHetqqXku64DhPfDQF/Vs4VtrqU81AotNLN1dJYCQ4FWOZRysbTEwGV8yOHnHts7+NyJV74Yz6X+dUuTx2d/cT8q/xaegK17N2DFoDqlGR+aojubZbo4yeDb41SrMHAuFFjlizA2+v+z9+ZRchz3necnIo+6u/pAH2jcAAGCIAniJAmSIEFSvGTLpnyuj7Fhey3v8/g907s79q7tGWPe+FiP560lv53x2rLHoL0ea/TGEmVLsiReDd4XyAZAgABIAA2AAPruqq47j4j9I6u6qxt9d4Mgqfy8V6+6KjMjIiMzozoivvH9QXMKMnnwbEg1W2gtkKYglRYkUwK/7LGiPYWUUCiXiGKghUQrielL4m5wPkVDAIqIr0B4VEwPx1REm+MUiyVsB6Iyiu8ENeUbHr70SEc1ccsmoWx0ySdf9hgpuhT6XJSfJy36ScUg2gCGDZEkeB40NsEt61ewNgYRKYg0NeBKcGWC4z0DGO3QujPCmVOXKA8O0i/0/7Hy1i2FTMyhEClSig3jmWUMfAw/uEIAgRypdo3kFGq0+gtcd8/ompPZxKCwQgXPqJAGvrBRmNW0nWpIzfG95RyVb2Ls/tEYmjERJ6J6vwmFEhotJQgHsBHaBGVTdhj2fBOkjWlGKZZy2JaFIQWuaxKLpXAdjw/OvM/Ro5dpbpUM9fdhGAbLmuH5597ngQcUmzZuJJcr4Pk+pmmSy+W4+eabGRoaRogg5HAsFsPxXEDgycCjDQG+rIbx1BIpDIQw8P2gCqW0qucYODz6eEEoQykQ2kejAn84raoiPRPD0EFbRxnHdTAsiRaBArKvd4RsvoBpNrJjxyrWr78B27Zig4MDN61ZX+LCh4P/5sixs/sKDrePOS/WnO0I2lYAv/o+uZWQ3y8CtZCPHUI4RDQgilNu9wGfoM2pYzrX65km9TPMvDDz+4G5iDye7Pw6jAAAIABJREFU4NPRJztAIEyZaaxzuuN6FphnN0Hfdy1BHc42zvkUQflqLk2fdNc0CM7/4BTff1qc4b4fWMvV7WuWxc+B7Ce4/vONLrCfxbVJ+1lY2N/F5HuQYAxsbTXvnhn2rQlV0wTzEgdm2T8kJCQkJORjTyhQCwkJuV5M9w98LTTmdNsPzJDmhE5sPB6fSzlmSm+2ztXB6vbpBjN+r7pPz1wKMg8OApRKpRl3isViS5nnbC5mixVAzCRQg6DTN5eBsv11r/kOMs2FMZeiWCx2kBmu72zXJ+QTw8dJoNZIdcB8ju3bQsgA3cXi1IP/H3OeAN6ZZZ8fBrrj8fh+5i6sXUvwrM9F/HoAyEx+/msTfjWq16+2OvIJrk179cPV13nGQ4D21OU/H7qYOYwqBINlfwNsi8ViB5jbQF0jwfnPJvyDYMD6AEA+n5/D7iEhIR85Gjoa24nqCEJJDK3wvQKNbcs4c3bESSaiVEoCqeM0WhbReIxmO1UVX/i07L6N7qNHeemVFyg5ms7lyzAtC9MwiEQimGYMQQxDmjQ3pkB4DA71kskMMjTcT1t74HSUiMeJxZJEo1GEEEhZC/epKVVG2bC+jTfeOcbf/+UBfuY3/ojP//xP4yoT6Q4z2vM0x959lv/1N34R5Zc5/ParlPLDDFyxiNkWxdwIqViChoZmkrE4yXgC7dt4ygqc1PzAlSkRj5HSkMlkSEab2XPnfWRHhnnv2Dv0XumjvXUD6zdupLFVks33Y8UMMgNDCFHCjMQYGHW5MlQYjERlz4WeHlCahqYUZ06exquKfKQGlBgTrSnpoUwXLbwx5VhVGsMkfRqTfpYA8AUM5QLhjBLgax/fTyOEQ1RWMAXsvPOGMQFAvTQpyE6xft0KIlEDpzyKbRuYwsIUNsKPUypVKLtFrISk5BfxtEMkEqGYHSYqPJ7+9plYJVfcPdBXZO0Gjjzy0K1Zx2zB0RE+u/3+A8+88NRD++5YddeGFQXSspNlSYOTx3rxXA/H0fgOHHo5+P9Fy+B+XLXCwHU1CUthJwHfINFi4AmJFAIhLEDi+hrf1yjbQOsKWkMyIvGrEh2tPYQyMCPB+car39tag5TY0sCTAr9SoVFKRASk9rCqlaSFCv4X0IKoBksE9mvRmI00bFqkh9AKo/osAFRcKA8H2qH8KFw5f4m4DYkYROOAKWhoamHNTZvIN+cYuFjE2xHjjRd73rvrrsf+zI43kavkSGp498h7aSvKbcKBRJw37r7rgbKdjEAkgycVly+VSTd2kEqlcByHRDSG47j4voevPBKJKKB48603SCZTWGYE1wEhqneYUEjtcerIURRQMSw0CbRqQEmNbQ0jZQmUj1H1bJurk1rw+AauiJevXABk9Z5XgWiz+g7QLkAqG9NNYmiFW+HcaL4wWKjklnl+AdctEYnEMIREKQNUhEqpwLFjl7n/M7exbvNGRnr7cDyXdes76e4+yssvnsGtlLht+06ymVEczwvuGdcnlU7jOIForeS4QWGFBCnQQgQiPCkxDRuBhVYR0CaWZYCUuF4Qklgj0UJjJCxQPr5XQlMB6aHxEbqM0BJTJTClhU8FX4PjlYjZMYqlEo0NrRimoqlpGU5Zki94PPfsu4yMDJJI2my59UYGBwfVwEDuhT333E/Zt9GGhY9AaweJ4r3j744920LIsf9fa4JWz/Orn5coDuhiHcpmC805Of3J+8+2fbHMN//ZuNblmy/XODRqfYhphc9P/9AGfDH1NIYjkvz9Nw7XC9T2MT6+lGU8nN1BZu6jdBP0dxpn2e8TxxzHB2uLuWYiyxRjJLONfy1Zu7FApun/1kJ9djF3YcqTTLEgbbb+/yR6mDSOOE35HqcanrFYLPZMtcNHxWLHhyad3xcZr+85hZv8hI5PfWqY4v7cN8VuT7DA8fG69qmHoA06yNyfyV8olUpdc9x3uvxr4uSueeT7Jar37CLavx7mMGcUj8cfZ3zx6VX7z5a/mL8dckhISEhIyDUnFKiFhIRcL7qYeqK75sKyj6sHhJ5gZvv1+a6ymk0UMDaZPwMHmN5FrbZ9/zzKNBe6lji9uTCbQK1rkenPJgJ6nLkJ1HoI6vwAwT20v3rsfFdBzcYaAkHF7xG4Nh0kDAP5aeXjJFC7jZldrJaCQ3xyV413E6yIn03stIagHg8RtPPTXeN9BG3IXEMG19KbKz3V/b9IsIr4Ca5de/Xr1VetvXqK+U+67Gduq0p/nfFBxYNM/du8lnHh8VzPd/8c9wsJCbmOKOGh8ALXMgWRiIVQFYo5zpULJWIrYlRKBYSncPJFbARaSZSQaAH77n+IgcE+rvT10d/fj/AU5ZLD8HAW34Oo3UIq1cCli5d4770LNDZBa1uCzs4VxONRUqk0tm1j21Z18l2OTcILIdDaJxqDz/3QXr7xndf4uz/7be6573GM6DLeefN5hj74DttvWU1HW4LBwRKPfeYzFMsF8tlRCsUc2vGoeC4DAwP0e2AZgoaGBtpaW2hqbGJ4sB8IRDPKV8TjabRWRCIRRCN85pGHOXH8FJcvXWZwdJhtO24gmoS+3vO0NacoYzKSzeLSTCZf+c6q9Zsc045CxaU8WppU10G4Ql9AIPgB0zcBE0Qg2qlNSEyeGJnKQU0KiVQVfCGRSLRqwFVtGJQxjUEMCYYyEdjjx1STFRoQHjgSwwDpuURsH+Xm+Zu/6U5IH/lz+x/I5QoZ4rFlQJy8C47nkrKjPP2NI7+zewv/etWqpuWxWIKzPX0jT3/r2b8ve/zuI4/dnu20U2xOqV91Lp7vthtjOArev1xiaAAsE6womDa0rRQIDLQIxFOuEvhCBfelUAjpo6o+cAIDQ1edxJSP1H4gykOPCSMsNV7XGO6Yn5hB1WVOj4soJCBVfb344+Z/BKJAqTUmYAgfVbPFE4F7HNSMyapuYQLiyVpY15pQTpMpK8ojUK5oIpFBIrFBVq1txe+IcrEywvk4X7hpWRlDD9P10ncamtL8we7d4meam2WTW1Fkh/WVV7ue/n/uefCuPyyVRtCmpK25FV+5mKKEGVH89X/9ekpq1K/92k8WCmUPKUooLehsX02p6KJcD9s08GuOhToIOyurH4WQKCL4KoHAx1dGIEjTEkQ1/O4c7LgmOAYKHcRLpa7OhcKv2yz1uFhNKslt2ze6gwPvf+dK//DPLmsG29Ao5YHpYZlxyiWP555/hS03ryEWb+DimSvEYgmSqRZMy+H++9cwMjTEiRMnOfVeD82tzRimgWmYuK5fFcBKpGXWhe4MwnEG4TwtEBYKC0EEISNILDTVsJ5i/AZRWqOFCUKgpI1UCi0UKB+0hdTVY6iFStVYtoFhCFpbWzl9soc33jzJ5SuQGw2ehyuXoXMVrF/fyFf/+79878JFfvEnfnL3pZLjEDFsKn4lEABKjTREnSCt7mamzoExnN8MuU5IPCR5rLo2oV7Ahg7aZXf8my4WdsfW+kf7+HiNA3xUzKVv1sWnS7xXczQ7yOwL0j7qkHqf1ntw3/UuQMii2T/p85Ms3Zj4UwT3yEFmjnhTCzW8VPl2V/P9IjO3BTUzg/mM/S2Wgx9hXiEhISEhIR8JoUAtJCTketE1w7bbCCbBDzJud/w4M3cQjjC/QZJGZndPm0tn4yBBx2y6sv084+exFNRWf36UNDJzp/AQSzNANZM7zxrmHuazRhfj9b6f4B5a6nB6EFz7+wjul6XsHIdcfw5d7wKEzJsDBM/6TG1WjdqzC1f/hsw3VHCW2YW8M9HN+CDf49W/r3V79UXmN8CeISjX1+ewb5pxURxMfJa2MX8R3m8QhvoICfn4IzwcqwgiH7gY+RJpmvgliKf47plzPXrVqmUiGTHxKg66JnbSgYsVWpIZcWlIdtDRcQOu56J9hee6OI6D63pEo3GuXLnMkWNH2bCphc03rieRiBGPR/F9F60VSms8pZFSYggDXwukYaC0z9BohubWBF5lhB9++A66uz/gWNdBKmWfWMTgcw/uoXVZisHeD6lUKgyXcwghiFgGqdZlrFu5Al95lIoVysUibjkQjZXKZTy3AiIQyigAQ2IJgef7VCoVkIIPL/WzfecOttzi8uKLL/PCodd47LP7aF/WysBADxY+ZqyBD06e47U39Jd/8mdaKOUNIpEEZbdMMITjXV31tfdJC/RrAp+aPk3NMl0vq2XX0+wn8Mac0+pDjkoArbCFwETzj994675YjJ9Yt4579txNp9SIEyeeu3T2DM+NjvLlfY/ediKRSuP7Dm8ePvKthx5s/OztO9aRz/cQizssX9XWtOlm79eeO9T3+Pe++8Z9Dz6w9WypSFMqCn0flnAq0NRgsLwtFrjsRUyQAsdz8Tw/cIHTCq30mAva+EmosbMJRE+yWnGBYKz+vKb1O6iKkWp1NVu9Boqk2gdV/VsxQT9xlbsSROyJjjdCSBpSJpFIBNu2yWQyXLg0wuE3B3AVRBMRlrcjDJHjf3z1+fW3bObQZz9748qWlgyptENmeARUfHlHp/qD115/5e7dd237AcNK4qkK33iqa0u6iV9ubOLBLZvpbE7b+uUX//vlC5d4aXiIr/7S/vsOZa7kiNotWJESyisitYOQEqXtScE+q55nYqJCxEAE4j4xMTxo7X6r3b9j99/kevVrqY/nM145Ek9ITBE41vlSYkailFz+anCo9LMbb9hApTRExS2DKpFKJHjp1VeJxG1233k7r7z2Nl//xzOsWmlj2ja2HTgw2raNYST48MoFbryxQropQiqVAiVIxBPImroQha46pwkpAnc5HUETRYjAOQ0hUKjAnQyFlLV7R1ZrQ6MBUwRto1QgfAHKrG430doFI2jXhNCIuofetuGOO9qIJWKUK0XaO1YSi6U4fux9jnZn/u5nf2r3pWLJoyGeZnh0FDNqoE2BMBUg0bgIAlHk5LDAcA0ckObrwLXUjmPTbp/u+48q/4+Ia13/S80cyjtTCa8KWTv19lp/Yx9Xi4PWVl8we2jG/XX7Uk3r496XqTlbz8anUTTVQ3DNtxH0xbcR1AcE17qLaZyLQkK+D2lk4njZIZZ+MWFNOFp7JvfVbeth/JlcarFsTaQ2Vb61tuDgNcg3JCQkJCTk+45QoBYSEnK96CYQBEwnIpg8uT0b8125MtvKwC8y9w7HAWZ2NTrA0q0Qux6DWrOJLpZqgOopZhZk7GPh53+w+lrLuBvbUofUSzNxEDLkk0/X9S5AyIJ4nKCtmI8Iai6CtunIMrXr50KphbeohVjZz+LKNxVpFva79BRBKIO5/jbXmK/gr54pw6iEhIR8HFG4poOihCUATBQC13VZvabzwqnjl7+8rOnEF7bdsplkLEm57ASHVSedlVZoz6NQdKpiLFCePyYSicYSnDt3jsOH32T37i1svulGTCHxfZdKpYLnVx3TAGnUHJuMQA2jDXwtSTWkEUaCYq4Mqo89t25A+gIMA2yTkUs9ZAfyeOUC8UiESqmIIQ0wJK7v4BQLgaGRVkihicXjmIaBYUq09vBdB6X8MaGNkAITA0f5lEsOb7/dzRtvdrN6VQvbtt3CSy+8yeuvdbN9dyemYZCILSNfsejtv3Dysc+teWEoO0rUbkSaBql4EjXDBL2sF0FpuSjxQ73QrSbAMjWYWo25WNX2G3NREw5f++p3V7a18df77jMebm0z6eiIovwSUoMhEy137LK2vvN2/xNvvXLkt+66b+t/fPPw0Sc/c9+Kz25YleLyh0dY0WmgDZdkKklDYwvt7beu/K9/c+yV//THR1dv3cpx7cnDjQ2tO4v5PKOZItoH1y1ScSv4gLTANIygvKZJxLIAOzgJ7VaVerWwlNX7A6rf6+Bd69l9d+oFbFNpdmb8TtYJPaquYqhJ4o+gjivluu+0RCkfpSp4XgGlFFJKWluWYWazxOLNXOkrHs4PV07+0e+/Zf/kj/HKj/3ojvZYNEulMkRp1CPdAE65yNbbOkmn9Wf/8WvdB++59+b9z75w/DfvulP88aaNHaQbYximSUNDA6Ojo8v6+/u2Dg5nf/W//X+Hvufn+aWd27d92NiQoq9/lHgqCkphVEWTYoIQr1rsa+y6VS8O1FWRWtAMKNLpBlZvWHfo/MVz763fsPKmlnSCYiWD7+Vobmph2bJGTp6+zFuvH2bNinU8eL/F+6d7uHwxj2HmiSeDtserOLS0NrBy5Uqk6aJ9n0Qiied7QfsABNe1GuITE6VtBCZCm4E4DXlViKVa2aeUfWk59pLaHP+uDtd1kVKSGx1g3brV3HLLVjyvghHxiUZtRkfzmEaK7jcPc+/e1r+7eOGD3zl/buQrpQp/cd9n9vT60sUXQQhgjR2U7/pG4QsJud70VN/31X3XSNAHmtyfOc94v7PGWoIxhMljTb8H/AKLX8xYc9y+j/HFqzM5gs837dn6z1k+3Qsyu/n4CwlDQq432+r+fpK5CVsXyvV6JsO2ICQkJCQk5BoTCtRCQkKuJweYmxPLbJxnfoMks60MnKt7Wo0ughVD003A30cwiLQUg0Y9S5DGfLnW4T1rPMXM4VL3s3iRQg8TQ+rtr76WOqReSEjI9aOHYFKhi2v/bNfEaRMGr5bIYSLD1e3V4yy9uHa+PEHwOzrX0KeL4UnC0J4hIZ8orLhNpVghGokhyj7lYgnbUJw9efl/X7PSurvvUpY3R4+zatUKVq9ZhR0Jwm76OASeQgGeqoU09PF9RSTWSP/Ahzzf9So7d23ghhvWonzFSC4bhORraCYSiaG1pr+vj0rZpampEaVqsRPBlBGEbAEvhiF8DO2QGxjF8DwM7YHwKBWGsaMWiUgEt1JAotFK4atqWD0hMWUgNvEV5HM5mpqayGYzLF/ejusYjAyPIAnCeqJU1U1JYpgmDzzwAC+99DwnTgxx9uyL2KagUIBCsUgs2oznNfPCy0f48DK/fmN7M1pbeDiUZRnlOkEYzZrXktYIqiIxAqHYmCuVqAqexgQxtd+lmUVrtbSmcwRLRVMYWFQqFYqFIo7j0JhqwPM8Xn7lTMdNWzny2A+saLasAq7KErV9JAqhbKRySbYafO5zN9P59vAfP//S0R/fvotda9cJcC7SvgwaUwbSEIzk8ly8kCeRbmL3Tqu9mHX/3d69t/7u8GDvrjdf6btZwu2bNrXsGezP3m4a5g2Y0YQ0DUxhVr2oFMqDvoEsQo5fO6mDdyEEpmEgTasqyvERaAxDYdTXVi3k4aT6mFw/k7dP5WQnLQMhBcr30dIIhHQKPMdDVIVy+UJhwnFOOQhgGQibVFVQJxHSAiiYhvHBpQujb/QPuq+PZPre3HfP3qMbV0lS0UO/v3NHS7tlDGCKIqlUmojto1WOguFTKg6wcd0NfOZ+/+efe+H4LQ89KHZuvrmDqOUhGAHAL/Riapc1nRYrO1NsXht5+Fv/NHjk2JHum+/as763o6mJUsVHa42Pg9b+REM4KdBaIIWg3quoFqqydq8qwdWiqOn+jZrCHim4XwMhl5KBR5uPRghJplREYjOS5Ymec5nvNt7ahmXGcEplrvR+yO27b6OxoYHj756imC2wZ9cuHrp/G319lylWyrQ0Lhu7vr5y8f0KaI0RtZFCI5QPCJpSreTLFcq+TyLeRMlxsSMJBBZaGUhpYBhyrF0bL7sc+0spQCjKlQq2ZWBYEI3EMUQErRy05+FXwKlUcH0PJJhS4rsuMTuObUi0W6JSyuHn81Rsk6GhLOfPXaGUKXDPvVtZsWb55nePnTjw7vFTv/X6q6/+ya47bv49acTwlI1hRpBazkGgtpSuX5Mu6IIcumYqzxzTHxPzqim+qz92vue+yPObsgyTty3melzr+l9qZi6fnOX3a46p91Q/3kYgNuuhKk6b4kzXEPTT9tV9d4Dp+2o1IdlCFzV1MXHMMc24O/bnWdx441oCEd1shIuGpmHJHSZDQj6+7OP6hLkMCQkJCQkJ+RQRCtRCQkKuGbN10IUQTzFzWMe5pr9/mvSnO/QAM4sWngAycyh//cf9wLkZdl+qVY09S5DGfNk3w7bzLHBVkdZ6ch1mmFnoVz9IuOgBICFEt9b6CSHEE1rrq0LqzXD/hHwKmOL+m4pwxdzHlDm0zzVr/i6ugUitmv+U4rR5HD8fugl+m54AHhdCPM41FIjNoX73V/+8JmWo5h+K00JCPoHkcjlMoVCuT9SwOHH8zN3tKf784X1bbt20fh1uyef999/n9Ptn6Dl/jkjUIJmK0tTSSDyVHJtY9lQgzDGExHVdMplhTp86RVu7ZOXKDiJRi1LJQUqTF154iQsXR0gmLfr6XJYvt3n00UexzBiu6wJBuyKJoEUUtIlUAh1YoVUn+hVSaprSCZTykPhgCFAeqqY+0gB+4NQlBIYUNDU1USoVxoRwVy5f5sS7x9myZTPtnZ1kBgaAqquXKUD57Nq9G8uM8O6x4/ScH+bmrR3Ylk2p7NLfP8L5i4VD23be/r1RHzwJAoWrykgxLgW41hOhcrKJWHXiv1IcwjYsTCloiCsc6RGPugz1D3D7TvH1hx67oVnYA7hOhpXLkyjPQWqzKlCzGR7O4jqCjrYUK5aza/PmBFL0Y0iPhkQ8EDMpl0QUOlqh7BXYuL6NCx9c+sKh5479u923L1ObtySPC81x29Z/Y9kJXn8ju25klJs7OtmebuImBFsUrNaaJkn1EgsN+FXvNH9Mt6ert4DnjZunQZ2zVU3fOItAbfJnqa/+LKtmfsoHU0IkArJOT+hXy1LTMAkBxWIuCIcpGAYuug7HS2VOFvK8Uy5z/DMPdZyLxhtoWebj+RZSFvnKfzss79jDFzo7YpgijymKmEgMDUYkSsSSnB3MkYyP0pBy2bqFnamExtCjRE0wdNXZ0IBljVGKpQKO55NIW/zID21q/pdvnf6aW+m/y/eKSGFj2hZxCwzTxNSgJIjqidW7+o37Gy4tqi7Eqo9AItBolPCJxSLosqZ91abvdR87/cLKFYl70/EgtKamTH50mFUrO1jeupJ33jnGP33jW6xf38quO3aRrJigSoBECzAkKNNCa4Xn+zhOkVgsQdlxOX36NNJOkEx3UilFaG5eTrFSQkqBlhpEBV8ZgbvaDCIpqRWNDUnyxTKt7StBGgwODNDV9TrF0RFSUrNpw3KaW6PE4gamYeP5DoVijuGREcrFIsVinmIhR7HkoDVEzCgP3LuLVGOSfGaIzTeuZuWqtljPhUv/7pU3jv/ocJZfumPPrtdj8aYg4u1MdV1zGpwG+VH2n6vt9rVLe4rvrneIy6u4jiFCr2X9L4jxskg9tUitXmI4y5WsRXqouaPN5ARdv20tM/eN0gSLjrpmzn5K9s1Sjv0sbrzxwBz3O7iIPEJCQj4dHGTubUZISEhISEhIyJSEArWQkJAFURN3zDQ5MkeB136CAZoFhS/TWv8C0wzwTCM+WcvMocnG3NiUmnnAzTCM+o89BJPp0w1IrSHowB2YMdF5UDu/azxBtY+ZxR1di0l8CpHQVKET6nmcuhVatXNfSB0YhjGWv1KqPqTe48AThmEsdUi9kI8ZcxCpLVXIxpAlZo7tc02k9hRL7zp2RGu9H+heSPszW/ln4SnDMJ5iPMTLfhYXQvMq5li/+wmekfmG+5xL/ksRAickJOQjR5KINmL4ReJGjPcPH/25227seHL7DWvYuLoFoSqUooI799zG6Og6zl+4QLlcxPcUVy5ncP3hMSGQV1UGjWaypFIJIhGLMx/4rF4jiEaj+MrD932Wdyxnx/ZdaH2U48f7MEx45OHHSKWbKJRK2LZN4FNkgLRRVIIwidpHGApXeLjViICG1uBUSMQtXNdlsG+AxsZGhJg4la19FwVYdjRwBwPi8QRDQ0O88cab3LBuPe3L2ill89iWjeM6SENiKRNfVVjW1Iz2YyjXoLEJVq9tZ3j0CoWiz8mz57k8wE+35UZx7TjYURAKQ0Wroic55f+9gSvV1ZEpayVXeu6hFqf1CZJQLJ3nzGXuRfH5znbuiFq0ZTOUM1kGU2nuHM1coLEF2ttTKLeIxEcqUY0TatDR2onrJenqOk5nG3S0RSgXClhEGbqSZ3lrMzJqYmiHREShtIcvSyTitLa2ci5XGHQiUdBg5MoopShs3MKoDzlh4PmahNYYWgRV0ZweP38Y153UqnBWgVp9KM86FiVQU2CKiQK12v6Tf36z2bE/he9jYNFhJUi1dLDHMEj1DvU2SElCWkgp8Kn0cdtO7FiU1oihMJTC0A6GoTEk5IehXAzyq5RHWb9mGcMjI1zsgVtuaiZhZTHqrv7ISI5YDJJxietoei4PIBR78vl8l5T5ZbE40eER+keGeS2X5+u2zYuGGBem1YeAnQo1KaKknrRt7ii0kPjKCERqInAXNDQIw8KKNJHN81OnT/Vc2nlLB7YlQHiUKzmSiTgVT7Nj1510rr7C8ZPH+ZfvvUBDQwO33HLLeBZCIQwDaRrYkSimNKhUSpTdMsI0uHJpiLMvXySd7qClvYn1G1ewZl07FSdHqZwjlyuQTneAsCYWverMZQCWJXB9l3RTOx9cGOWfv/MCmYLixlv3sHpNhKFTz5BOp2lojJEZ6cUyDXwlyeWynD/fg1vWRCIGXkWSGYFYzObRH3yMeDLC5d4rCGGgXEFbcyPNzWna2ptufv2tY6+9/eZb//Nde+/6a4mHjz1W/zNdu6Wh/oZfXFjixad/LcRWS3F+dZKq61o/Hwcmla++jdDjwmo9zb2rxERh2uR96tqcHoLxySeY23jXvup+++ew70KZLYTeghb9VlnL3BYdPcn1WTAbEhLy8aLnehcgJCQkJCQk5JNPKFALCQm5Zsxx0j7D+IDOvARBWutf0FofnGexDsx1+wJEBweYeWDnCQJx1SdJ9DJbeM8Fr9KcRhz0FPCnMxy2j6pATWu9KIGaUgqt9dh7lQyBKOIgwUBdTQByvUPqhSwxc3RQC/mYMo9nvptgpfpBFjdwX8+XtNYHtNaZeZaIeLwWAAAgAElEQVRljCUMAXqQ8fZqf/W16PZqHuV7gqDdPrgU+RK4aD6htQ7dC0NCPpYoUN64rdRkDAez7JE0LM50H/1XW1Z1PHn/zttoiCj8Sh7XLYMdQ0if1vZmWpY1A5JKpUKuUKJccccd1HTgoJaKJ4nHIxRLBXL55yiXHTKZDNFoHNOw6O3rZcWKFaxdv4mHHx4lFosDMJrPkU43Ui5XQJsIYSK1xNQaX/povCAkoaFRyguCi2pFc1MzJ7oPU67kaVvRiStNfGEGaaAwKSO0B4Dr5pGGIJG0SCYaOXKkG7dS4qYbN+I5ZWKxJIZh4zkOoBBS4Wsfp1ykUnTJFzJs2boGw1Z4vuRK7zAnT7m/+uhjt12uiAR9IzlMK4pUElMF+Us/aJ/rJ9YlV4eUnO76+dJDCYVGjwvWNIAAbVZFRSoQKWkPrcoIUcaSYAh2jGb5k107eWDdmnYsy6SzYznZ4VGUqzh/4QPeebvCsja4c49JU2OaYnkYIauhEKXAiDRz7Ohx3DLcemcTTmkYKUAKk5OnYGRwmBs2JpAJQdkBpRWW6dKUhlu3rFi9cl2CshN0pSKRCJ6nKJfLuL6PYdnBAipBVVQYhPKsqdN09b4VSqO0RgqNaQUhPn3fR9f1CcYFahqQM0tXhJog/pvqWkgNUkqEkCjlI6WBaRr4Pvi+h1H1dqs5NMkJC6EUQogmIUSTlBpfKSqVUrUOgvI7fgXlg5Q2w/05ThzLY0cMEC5UxVoAF87CpUuwdbvAKRUQEtqaDT4879P/YYZNN5jjYWKRxC2feLqdXO8Ar74+wmgBtt6aYuOmdfe5noPvO5TLxQ2FQmlPqcRvPPN09lkFv2npwttKx/G1A1ogtARt4gsfLXyE9MbEeUHd1oYmvTGRzJQOSNOITnQ1DV8WIPA/RGrFqKuwhcVgLs+GWzdcPnnyzK9uXMl/ae2IYFsK1ykzMjJAY8Nq8oUSnStW0NbZxnunTjE0MszLr7884bqk0kkaGhpoa20hnU6B1EQiFuu27eDS116grfMmbt11Pwf//kn+4ivfZs+eW7n11jVs27qG9pXNlHPu1edkVPulAhQKM97APz33Ml956gWeeTGHC3xw4kus2NTOi//lPfqHBogmW6rnLYlEYnheL5cva+65ZwMrl6+hIdlJIVvhmWee55mnX2DvfTuJxyJ4CjzXZXS0hLQkzU1x9t69jXji/b868s4rLYjkfwSzer5j8tYxtyyt/Go5p74+hiEWIfNSTJQPzY25HzHRAW1i+WcQPtUz1bO9JPnPcMyEv6/ObaGebldfp2td/7PlvzBqba+PgzIBihO21//MzVpWZVNti7oJ+o1rmH08DD4ascZS9WOn4sAc9qmF8wsJCQkJCQkJCQkJCVk0oUAtJCRkQSilZhV3TOXAUjum6lpV+5wRQmwjGPB4ghkcu6qipENa6yeohlWrFyrVY1nW5K/WUicgm6J8Y+5ptXTnWP7aew/w74Hfm6b4acbPcUHUzrXewW42J7tFsm+W7V3zSUwIgZQSWZ2RqJW77l7qYTykwlVorX9YKdWotc7UjpmPE1FtX631mAOeUmqsPJPooS6kXt0rPanMIZ8Q5nD/hXxCmGeblyF4dvcRtMELchvTWj+plDqgte5ZSPszKa15HzOH358D1dc+AqHaWHu1FOWbIf8uAhFgrb1cSJ7nCcp+cLr869tv0zQXJVAOCQlZGDbwi59/AKsWAnAShhhl660JTr998q71Lebf/sCdWzG9AobycI3AMkoLg3y+APlASAKBcMeywI5GKFbKmJZFNJ4iFovTc/Ys73/QR2/vFVLJFP19Q5z54Dw333ITsVgc7WuGR3pJNjSTSqfIF4uUyw6VSgU7EgEtEVWBmWEagESg8FFo5YF2KGaHiMUjRCIx3nzzKP2XLnHf3bfgmgY9+SLvnLqESYK2hijrWyWNCYFlWRQreRyVJWIn0Epzoeccq5a34Dt5DG3ilSooaaIdTTSikbaBX5HEI1HOnz9NulmQbrEZLWQZzfl0H81/26nw5889ewR/krOU0OOT61O5UvmT/pWtiR/q93NNuOXedbhmGWQZJaqCBGWjdRLDj/JQ5w0kzRiOWyYaaUQ7rQhyPPP8//uFGzbyF/fsXY4QRSRFQJHNZpHCRFomGzYsY8XKUY4cdeh6usDu2yusuqmF3MAQUVtQyLoox+NCj8PqNeCrEQo56Gi1iRpNZPJ5KgJuSEXwcCDiE49GudyTo1KCtSsS+OUhYqJ6/5VL2IBpARZoUZhw7jUm/5s/wRCvFrFQAEYg+Lk6jdlkDWpMVCVrIrhpfpq0kBN0PyBhgin3VHlV0xTBTWEJiEZBKw2UQEPUlGhbkMkO09SUxIrAcCZD6zJFJG5imR5OAa5cANOA9pUbyA73ks1WWL18BRfPXODY2zk2rW+nb8CloUEiMIknVnHp1BBPf0eRTMM9+5ahhYdWl7AME9vUxGOalhYLjUnbcvvB4ydGDr952PvC5x6998ueakNYMfKVPpIpk2Onukk0SCzbwfcKGAKEkqCjAFzq+wCEN3YNJoeMnKpeawIVJUAb/WPf+4AvXDxAtkiKjs2u3Tv//MWuw5+7/6EbHmtq0kQMha/LOKU8UTtOqTyMYRvsuXcXGJJDzz/HO+9c4YZ1KTo7V5Ivljh56jSn3odHHr0vEHSaUOrvJ5MvsWLLzaz/gf3c9CH856f+DV976xg/+nCWveezbF6T5jP77iY71E8sFiOXz2GZFkJoLNsglkhQdCt86csHMVq28uP/+t/yL4d/k6ZYAyual0Mxx6n33mPLpjjQGoidDLBtk0g8BhLOnT9P5/J1nOu5QHvLCnbfcTsvvfg8L7z0Itt330ZjOoWhBI6vUJ6HMAziEZstm1YiTeuP//FbfdbP/tzeP8gMO6QbWqh4XiBylEUQHm++9jZKSBwDXDn+nBjV6zJaHJ2n8GjxITNnkY+OMyk859QCsfn/Xz/nM5hT/lMxc1DKOZ//lKl+hPU/Zf7zzGuGEKueKLLvkTSemDjNMeZOOUN9awH4DTz/vXPgS5TgKcbH9Or6NVPmf55xgVrPVDvUkaU6hrkAzjPzYqAj8Xh8IeluY27uaV8sFos9C8ng40KxWJx9p+vIx718i+XTfn6fdq719bve98f1zn82Pu7lCwkJCQkJWQihQC0kJOSaMdXEfbByfGJoyjpxyAECd6yakGDtpMO7CJxaxoRptfc5igQOzrJ9f/2HBZQfgvLPNEH/69V9emYr7MeAtczsaneERbjBzeBg1TVLvo8DB8ccDuYpEKkd53keUkp835/LYZNDgO5niUPqhXy0hA5qn2wWKAzrIvht2UbwDO9jdufOQ4w//z21Lxfa/tRYyHFz+P2p0cW4eHg/QZs1r1X3C/j9yzAukKuJefcxy0RKtZwHmTRZM139TBalheK0kJCPFglYjBLRUw+SmxT5u788aj7+SOSpH3z4HpY1RdEVF0+ZlLSJh4EpJ7Zd+XwpEI4bGnyB1opkMs3l3it0d3czPFgmEYd4PEkkEuGhh3bw6qtvk82+wZ133EVHWxv9uX56P3iPSsWlo3MlthUlErFQykeIKIJqbEUkhhAYVQsgX/ko36EhmaAhHeeVV17h0oV+Pvvow3h+hgsDI3zpK2/w9Iswkoebl8Ojd8fYdcs6br1lI9G4RUQqhPLJjQ7jOUUaOjqwLINiroTj5Emlknh+Ec83MDTYdhRPKy5+2IOMQCzexJX+DK+8drG/b4DPS0kQqqxaP8ak5rAWwqz2NwQT75NDeE7nNOUZTp1AzQNMUBJ8D8NX4DkIfLxSP56fRTtDPPnkPz/xr36x5U933t5GuXIRQRmQQVmEgayLjVl2He66u4GjR0b55jc9fjSaobWtjUwmh+9anDz5HiMjsPGWIMSlaUEyleaD4xfJleG+x1YgYzHKrsSKCkZGc5w6A+3NEJWCvCOZPIwlqueGUIHWTKiqGMFH6quFfuOfjUniBTm2TVc/z0Yt7OqYSE1LwJ/agEkbk8KsyqkMmabKpfo2MdVAoFZddGFIhDBYlmzFstPceGOEw0cGefjRZrADRaMlJA8+upbvfvNtzpz4gA03r0L5Q2SyvWxY30LP+SHeequPTTdaKJUgkVpGdrjMP32zyJabYMfOjTjqMggHIaxA/CkFQmiE9NFIDKvEju2dWEblL5/886/Gf+FX/qcvVRyTmFXBtiN0diyjUMni+RUsW6M9By0lQkm0UChZRks9JkRTky5B/f0PkwytBGjhTBCiqJoxnQmuUuQrHsWKePy11z64+IOf296mdAEpBJ7vYEiBMH1832V0ZIBDL77A4JDDI4/cyvK25USjKRQS13W4dOUyjlMO3O8MG601m268gXfPHmPH+RP81K/8CqfPXOKd7jf5z3/+J0T8y/yn//AbeOUSDz6wh+HhEQwhyGazxOIxWlqa8HyPv3/yHxgcKPB//9kfki9GOPLOfbQnE1z64FUOffMgN2xYwY5d6ynkhvBcF8u28bUimUqzfKXJiXc91qy+wuYbbmNoKEtDOs6P/cTn+e73vsnT33uNe/beSiqVwMcLFvNphSEkrU0pWG/y2Gf077/24ne4485H/qBUHEVGotXrEtxpvtb4aFwBjgS/WtdWtZ2qGHMPJXz1BZyCqUJO1kRKQl0lWJw5JKkae86nzX6eXcMlz/+qDCY7qLGI879apDW//GsHLWH+s9T3bOnXtmsBSjgoWZ5wDSc7jU5XFsG4kWiVbiYKwrJMP753oO7vp6qfp+v/PMHCx8+6Z0i3lvd8aWT2MVII6uKLC0g/JCQkJCQkJCQkJCRkSkKBWkhIyGT2zXXH2Zy7pnNAqbkXTTOxXh+ybFamCNE4Ewdm2d5V/2GqCfKaqKXehWkStZCljXMp0DRlmNPQqJRyPue+bwFlyQD3z7C9ZwFpTmAakdABZh5gG8u33lFuIXnXrvE8xCLXLKTeFBzg0xFG4d9f7wJMh9b6gBDiwDVIejHKt5meuY+CpQxB3DXL9p6FJrxQYViVbiY6We6bYp8Ms6xwX0z7s5Dyz+H3ZyoOMt5ePU5w3rO2Vwv8/atRE/TV2Ddp+6x1O1v9hMK0kJDriJkBffVPRTAR7LB9B7+2ffe21uSyOCWvgMDHcQwyBZOK45PJXAA57sBWyOeR0kAHcR4xbIs333qLoZECWsOWLWtoaGigoaEB8GlpaeKHH3+Y5599nRPHz3L8yBlMC+INBvFEjGjMxLZMpBlBqyCsY03XI4VAIlFaIVQggpFSkkzGuXjxPP1D/ex96G6yukzfUIG//fobfOdFUCYYBhy+Ape/WeJrz57gpo1nePj+G1mzsoJf7GXbpq0YwuVKby8rV67EitqkGgyUyqJ8B180okWEXH6YU6dPMJyFu+/bSn40xUuH3qV/gEcefPBO59nnXwMmuqRNN+mvxMR96lvO2sT/VY5TwhtzqDJVNXSpkkhfYilFOmZi6SL/8NQbMSFJGJr7f/lXVv/pTVsbKJcvEI1XqoI0C6Fs0DJw0BFllICV6TYGBvrZfoekqVXR9ZzP7bti9A8MkB0pcfYM7L03RjLlIgyPWBy0UvhALAFne4ZJZVvwbZOzF3vJjkBcw8bV6xm+XKGgLXxpMYXcoHrONRHIFELryVWhmeBqVBOl1YQLSkzcflV6tbqthj+UmjrRxjSuR1peJVKbq5PS5D5T/W+hlBJLG/ijPrGEQXN6LY2tIxx6ZZg1y2FtOkpEJxjN9jCchZFRICZJNwuyRYfWFUVGS/DGm1AquqTSOZa1JHjt9Uvsvd+kvSPNUP59mloi1bIAOngXsupSpyHdGMH3PfbeeyOmHf3iP33jK5cw6brcT+F/+bW9pWx/P5FYFNOWKEehhI8UCi1LKKnQUgf3de2cGReS1Op78i09QZA2SZBYX9daKhJpmx137nS+/c23Hmlr++Cd3Ts2Ywkf1y8jLUjGE7j4fOe7z5DLwX33b6OtrYOR4QyuC62tHcSjUSwD8F1My0T5GrdcYeOqVkaGT/PPf/1bpFq2sP+xe/i9//MLEDFARrlz9166jz7Ntu2bsCM2hpTEElEqlQqe53Hy+Gna4+20bNzEhddepX3NBrz+93n26VcoXHiXTWua2LXrNi5fOkuqIUI0nqRcyYG0iacaWLVyHZc+fJ8TJ04SicTYuH4DV670oo0EDz/2GM8+8wzPPHeMnbtWs2njBqQBjuOAVkghaUun2Lv9RqLa//1XnvmOuvv++/7IERpHyqorlRk4AC4lUwmgrsUxE6g7/rqsVVpk/os+/0WmtZT5z5uZ855NIDfdPkpM6c54kHEXtZ7q++SFTU8ycdwyQ7AQ6otMdCU7T9AHW4iIrMaBatpT9eO+wfzHjRqZfWFojcUI60JCQkJCQkJCQkJCQq5ChBM8ISHfvyQSiQUf6/s+nufNe5JdCDFhgrv2ea5ORvWCAKXUmEBrqrZstvObrexTWShPVfZ6V5lrzXzOPxaLfSRlmo5rUX/1gsTJdbDUzDNEQi28XTfV1aWLteBeYIiGMa63BfjHsfzX+/n9JPFJv38Xm/9UfJTtz1Qs4f1bc5BbSyBau4rr/ft3vduvkJCQqYkCv/zja4kwfNU2qUFSYXl74vS+vTs2NiYkH559n9zwKMW8f3Z0RPnFUmnjhg3NIMoTj5VGMEFsSM6eH0QraF0eZ/ONN9LUMNG0ROPTkGokk6nwV1/+HmtWWmzbtpXlK1tpSCcZzRWw7CjStDBlFEEEQQSQSGkihURpj4pTwvcraCrYEcGrr75INBnhptu2kPfg9e5L/Pb/dZjLI2BFQTlQdoMyNEYMvIpP2oD/7VfT7Lypg+HzF/EcuNhXZMstG3C8DJ5fJhaNUyp5RKwmbCEY6T+HQrFtxyYaGjs4e97l6Wff+MObt932O6mGRr797efG6rP+vcbkFlfqYHLdF1O709RPupdtuOmBdipmGVMrhJYYSmIqE6FMbB/OHbvyU8k4P7fuBrbHEiT9CgnTBEPChk2wZk0zEg+0jVQShQd4IMuBg5aZxrIsegc/JDsCLzwLyoXWdpAmbN4UJRoHZJlUg6CpOU25pLCMNEeOXCSbhf4MpDsiaEdijQpUn4Mx6JMf1sjkNC5Adec/2ZXnKheeqw4OGDue+SFqIUInpT85Xz1m0zMxvznnM/m869IyZBC8tinayEAmy6hQpJZbNK+wiSV98MvkRsG2oHOFyco1CaRVItaSINs7QnYU4vEohYLJyffyFMuQqcoRduyClauWIU0fywKEh5A+UAv3bSCxUELiefD+6SEGeqFYgtFRQFDwBfmRUd65cIG/3bZz1T+0tDVxeeAS0YYYuhpqVgnFxd7LaDku0JysD5R1ws3J9afE1de+vo6ijsXG5E0kvCjCq/D6K0d+/yd/5I7fSTcYoEuYlqaifLqPHqNQgkce2YevNUqBU1HEYgksM8Ibb73CwOAAe/fuJBqPUSlrYlYzShukGpsYHVWcPD3M5d4ShpEkmW5kaOgy7Z1Jej7s5t5776S5uYmoHSGXyyGFpH3lco69+jZx0YgZaeLQW++gbRNfFdmzazM3rW8CXIZ7+zEtSamcA+GRLwxjmibRSJzMcJazZy4wMjIMyuPhRx4kEY2RzRSQIkZbexsnTx7j2ecO09YOe/fuwTQDp0mpwRASpSBfdnn3vQu88PrlP7rr4bt/uyJtHGkD8M6LL6OlpGQoHHPcQc2sDquMVkrzc1CbNxPHb8SkG2R2B6+Jxy9WcDd/B7HF5r/Y85/4ef7X6qPLf6pwvjM7qBG4/c2Q5uTjJ4iRvWae++4QeNHad2uBc3W7f14h1zK+EHUsssM0rK2+Zl2YMw8aCcacahEbvlEtx8EFpNPF3MRp36DaXwz7ZyEhISEhISEhISEhS0XooBYSErJgFuocA4E4bCGT2pMFWjM52FwLB5b6vGsOMh+l0Hem8w9FNteVbiaFiA0JCQn5mDLZQS4kJCRkHpig7au/1oDwVje1xDYWyjme6zrSWxgp/0Mlz1ND/byydhUv37/3NlatasM2wIpaGKaB57rYto1pR3nuUBcNKYONGzexavUqjKootlAsorWmIdVIIprg6NGjvHX4XR64v5MdO3ahfEmxpDDNNJEI+PgoX+HjByFFpcaQZuBe5ftB6E/lo30Xyza4/OGH2GaEzZs24VeyVLwoL3Wf5fwgIMEtABjBueOSFzaWLGEl4Cd+6gs06CH8VQUcx6brnYtcyhcpeiNs2LCZ40ey7L37MxRKw3R996s8dv962lttUg0NvH/2Aq++ef78QFb/rohUKPuZQJyzAIOaqSbep5rgR9nBtVJB+FDT97GUy8UPBmL5DP/jRz6X/OzyDpPmVo2iglsy6O8t0HsFPngX+s4Pk0rCug2NNLfGGezvJ56SxCIxNDaZjMPFC32cOx8IqrbcAqmkSSoVx7AUplQYliIWj2KYmnLZwbbjaB82b1xBpeCiSTCUsRl4N4f3ap6W0Q5MJ4WhJAgHhDeh/1VzTJvOQW1K57Sx+3Z6B7XJ2+FqFzMpRZ1jWhDmU1Y/iynS13WJTw73Nxdm6u/5ElxDEacZJcAZKlM8kyO1u4W27TY6lcfwSpiGjxIlTAO80QLJRIREyiaX8zAsjy23xlDCQws4e9bl5Gk4eWqQzTfGWbOuHWmWsaJFpOmgtcYyYgwPwelTA1y5Ejwp0QisXgWdy9MgygkpKgmlY492dzuPvvjSxZ95z7j449vvWFEqlX1kJIIv1VXeSEpcLcic4JY2h65vfXVpKcgUctixOEJE0ZJ/+41vvf6zP/gDu9asXdvEwNAlXn7pFPEk7N69nVgsQW9/P7YdJRaLYds2vqdIJVMMDw9g21GUFggBFd9DmBbZQgVhxNh842q2bDRxyy4Dff3ctKqdlWs7+ZfMKdpSKUwtwfWJmTauW6b3zBmWtSSJYiJliR984Jbq/eghhMPolV4EHlIGCwWFEEjDwDYtyuUyyViSxsZGnNJp1q1ey2humK6uLu7bey+pVIrhoQJ9vb1svm0b6XSCY8e7+ed/fpU1axrYsHYtK5Z34rsViqUCDXGLLTd28v+z9+bBcl2HfeZ3zrlb729f8fCw7wTAfRNFaqG1WZLt0VLx2GWnauwZp1JWnNSMPTVxzNj5J5mqxJ7x2EnGFcvjcmzLtkzJsrWQNElRpLiAAkASxErsD29feu+7nTN/3H7AA7iAEElLSs7Harz3uvvec+7WrOr++vdzcvJ/f/bA01urIf/T+z78YDVKIEljpFRIpYD0DRLAbvTF65rr6zpvq7xeaLreeDd4fZnrvH90w2+33Oj4b/34jW//9Xiv9/+NcX3h7+3VLt+o/HvV+CbbTmk4qwV/xJUktC/KK8IZcN2tP8u70DhwDSu885T9G5HTqtj3uCwWi8VisVgsFst7gBXULBaLxWKxWCwWi8VisVwfI9+49tAAQn54abGafOPU1K8trfD/PHD/+zomCjn0/Auf2713wx3Do31kAtGV5Us9vbRaDb7y8F8jpWTr1m2Mj4+jpKTRaNLb14vruJRKRQrDYxx5+gWefOIVbrtjgv379xBFHRwVUC73MDMzR6HsI1CAzL7MIVOMMURRhNEC2e0mXP2CR7lc4eixZaIoopDzaTaXaTVSLs42swlqAIFc/ZUcSadJMQc/+7P3M75+nJXTM3Q6DTx/kLHxcb722Df4+Kf3smfPXkxnnnJxhELJ4c77bmfDlh6W5i+wcqnOM8+evXh6invv+8AOE+sQz82SW4zIxlod8+3UlgnePFnqqmOk85B6CA2OTqCzwoljVTU2yPOf/fGBPYP9AsepY3QHo7P19vfCYE+JOFLMXFrh7Gk4fnyFDZtX2H9zmXyhwPLSMkdfXWZhEUpFWDcOA4MltG7j+hLfN7iug+ukSCVxHIMQijiGWrVBHLfwTJ6iKTN9ssGFQ9NMv9DhTrWLnmYfJs1liW8mQpK88ZeTumafWTX8xLVpP1c/X15zHuuu/LAqYei3kCGEEFc9KoTJqk55K8lFZl8yWj0+5urx3imp1HRcjRYJSkPsJCyuuLz2jQucO5+y/b5exjdWqLWmidOEfK4CIiHVIVq38XMS6QnSJEaL7DrdtdunNWm4cCHi+QMtzk+dIcjDuo0wuWGAarXKq0fmuXgBfB/6KjCxzqOnnKe6soLv1lCYrGZXt9m3vZdNE+VPfPXr557/3nen9u25bUKnqQNCYUSCWe0OfQu+H/kkO/YSr1AkTgS+F3DHffcaj3DDY08eeOT2xtiHj5+4xPr1JTZMbqRYLDA/P4/v+4AgDEM6nYjh4VGiOCJNwXNdWmEHLRzAoJAYHATgmk72KqQ7TI7n8YsBTz31ddZPjNLT20fcDml1OiAFUrqkJECKkRFSJNm51K2Mxejsscu1vRpHOSASXMdHexrPc0iSkLm5Gjt27uDu++/jP/3uH3Lwey9z8/5bMST4QZ6Zc6cZHRujf7CHEyeOcvToSY4ePcbs9AybN23Gc11yuRxO3kMGklwl95kXXj5173PffuTX7rjz3v+v6Hs004Q4irLqUovlhwhxRS67odeJayuy1/AQWXpYpXt7AniAH926yw1kiWtvR06DTE77Ud1Wi8VisVgsFovF8kOMFdQsFssNsTa5SymFEOIftOLMYrFYLBaLxWKx/IAQ3aSoa9ACpHGer6/o7ds333RaFct0TAIiYnSy9z9s3LSecrlIu91CC9BSd2WxlEcffYRWK2b37h2Xk9Na7TZCZGKI57kURoZ4+htf55WXTvOxT9zG+NgEjXoDzwvwgjwLy3M0mnUKlWEw3RQsY1ACtElotWLiMKG/t69b+6cR0iAdSafTIZfLQZzixDHN+SrnXotAgtSgMChSDCkGcJA4kWbb+kFMNE+jfRFkC1/FTI7k+fSHt9OfNzQvnWXLUC9f/dP/m3J/iw9/5C5a9ZCzZw4rsWUAACAASURBVFo8/cz5J2LDZ+//0N6FlJRO1CFt1DESlAGTXnbjLiMNaySVK/v98qHharVnbcWnNNm2aFOGFKROEKZBOReQtKt/ef89/p7+SgRpByNSpHJwlKZQLkAq0KlieaXN6ITP+o05FhdXuHgBnn68RjuqEYXZ2Nt2Q6ksyBfLaB2iXInnS1w3RUqNo7LzJ0kTdCK5eCEmlwPXcUlaimPfa3D68TnKUz7vL+9FdoqkQpI6rWxbUglavi65yUgNqK6kprqSmrpKSlsVF9aes8K8sZR2RRp7Y0nNAOnl46ARIltWokFI5GVJ7erl07V/i7eW4L4flM4KNxUdVCIZlIPkkyKLr5zh0GvLzD+wzPr9/VRyOWYuzVAsgxckOEG2TcoB5WfVmBpBGBq0jNiw2Wdyi8vcTIOVJThyCKYvLrCwCLkc7N7tMDxSoVR0qVXnSPUK69cFiDRCaYOrAeEQimVGB/J8+uMb9vyXPz37l61a56fcUhkj82gRgXFAxFf2/zXn+/cj863WhWIkXr5CfT7myKlDxbwnnItnlouO5mT/wPSHN2wcYN9Ne8jlc9Qa9SwpTApc10cKhRAOTz75ON87OMPOnTmiKAUk0shs33WtUsdoXA2u1mgRU6wUmaotcWZulu37bwEEWoDyfJIkAQy6K7fpbtVpVpmc1edqAWn3xL2y/VfOL9/L0e60OHnyFJUeheu6ID3uuH0/B547RLl0js2bNxKGTUqlAisriyRpzPr1G+nvG2R6ZoazZ85w+vwcI8P9bNi0jqHRHvxcyp5d46xbPzD6vRdO/VFt6tSvlQvBw/Xl2pOdJPyWdAODXJMQ2E10NzdUkvvuJnC9Xkq63vr/Wx//ukv8gMe/4RGu+uuNXg/WSmrX442k7sv/L8h+ngV+G/iN7uj7+NGV1B4gk9Mq13neKr/Tfb7FYrFYLBaLxWKxvOtYQc1isVgsFovFYrFYLBbLW6KBmOIb1LplpHReuWXHFuKwTrMdEaUtjhw68uP37B8e85WBOAK6VYdkiVdf/vJf4Dg+d9xxMxPrJgnjiEajDkClUkFIQalY4pEvP8zzz8/yk5++mfGxcZIEkkhSyOfw/RwnTn6HzVu3ZLNcIxcZk6BTTRS3abc69PWU0DoGkUlFnVYLz/UolQvUajU8A51ayNw0KHFF+JLdW4MQAJHCxnWDzM9coNVeJgkbKDeFtMbOyQJJ1GJx5gyOarN/5wA9I4KwXef5A6c5fXrp12+/+4F/U+itUGvN4rkxiWlTLpUR3VpDLckGN5Cu3ieAN/vgvZu6lspu8NKaeUO2Di3ATRykBNdoFPD8C7MPPvhB5ye27dhApzmF0YbAcwhyDn7OAWUwcUxk2pR6JKIe4bsFCvlNlAtt/uwvptm3F/bvXU+xpKi1zuLlDUFe43k5EBFaxwg0UhtSHRPH0OpA3Ekp+gEjlY0sXqhx6PEplg5Df22Qbe44xXqeSLkkwqBFgjQaYxzSa9/GupyctnqWXhEOrtW/0murT9ekrBkByepyq2LfNUKEZlXGzB6V3XVoaS5LgKs1o3rN+XNZsLpcRfruo4XOZCy6NwNKuzjaRYlxTPsis0+28Bod/N29VAY30mrNEJo6woDng5eFgV1O7nMCSTFXJg419XqTvl5YPz7IyrLk/IV5Xj2k+dRPlNm+a4S5hdOkxmegP4dEo6MYpVw8IUBIEJJCOWa5voCbH+Geeys/+b2X5z88WRx61MQGRzt4cT6rce3uQymvJM6tFTaVef11oJFI3a0fFlH3Xnl5/8s0T7utyZV6aCbJQLvZ+u6Hf2zvyEDFZfPkCKWii5IpcRzh+z65nCJfLDA7O8+ZM+eYnZknDEP27xtgaXmBOI4RjiRJUlwFCI0SKcKIbPsFCCWJdcorR44yNjbB0OAIcaKp1Zs4jo/juNkcTZxZgWSyGyLpJqdlIq1Y/TKgEdkXA02S7VKhSOKExaV5Dr80xUAPbNywkdmzU9x8613k3AJf/8bTaB2yddsWUpNgTIrnefi+z9zcLDu2b2dkbJQnHn/avPjS4smFerMxPN93S6EUMLougMiwfXITtabcWW9f3KlNXYcJjwRamNXK2kSb6/dDWizvEe+WGHeNnLbKQ2QpaqupY/vIxLUHgEPvzsjvOQ/RlezeJk8C/+y9mYrFYrFYLBaLxWKxWEHNYvnvmmaz+YOegsVisVgsFovFYvmRIAHTyX6+IUs88p9+DWU8YuXjeimzZ47804nhAn2OQ1xrkDoOsRD0DVZ4+qkn0MKw9+Z9jAyv49L0PK6SDPYP0mq28ByPQrnMa8dPcPTILJ/8xD4G+oeI4xQlAsrlgMD3eeXIS9TqCxTLOzAmBURX6EhRSLSOuXjxJBsm1qOpY0QmfCghCNsddu3YSRi10UkHrXM06vMEAnIeNCLAgNv13oLu1rtA1F4kaUHgFujkNa24TVl5BIlmfuYSRenh+yvs2znM+ZV5vvTwgcNzVX4xxXn+W898B0GCMCAEKAWK0zgCQJArdNUqndV+apmASLjvvnu6NatBljYFIBK07JBKOL+QhboEuoOjQSQu0nWICGl02ty6axuYFEd18IMOYfPkv91z2z6WOiuMjW/A03UwTYxpo2kThRGeJ3GVJGyF9A3n6DRTTCR5/sVpbrkdNm/NkS92SEyH/qEA19MIPyVOI9IkAW1QWmK0QYdQq4JxwXd78NJRXnlkhRPfniU6K9g7sIuSE+Aah8QxQIISGiUAITGkCGkweo0MI9ZIadfWdr6BuPBmmWWJhMjJzm03zY650t1EHqkzOU2tSgwKoVdlIk0qMjnNS7Pq0JYLiZQkmbGGozOp6nV5RSJ+k9l8H4jVbTMY3O5vCRIoiiIFtYXObIPqIyu8dPgipb05Ru/uJ1EC49QwERSQFDwf4cZIEiQJjk7JkaNQLNPULTqdKgW/hx1bJinmpzh8uMaO3Xl8N0HoBKM9QCGFhzQOsQbX8aFYwJeCoKhJGopN20Y5crL67zZNVG7p752gutyhEgdIKYnSDo12HRk4GEeCI9BKYBxwpMRLs2OkdLbFqZBofA4+dyLbFyruSl4KKXyMFCjp0ly4hCMU5b6hszmSLyytNP7zaP9IBaFpNeogNPV6HTfwuTQ1xdT0JdqdCM9zGB+f4I7b7+TM2dMsv7iIMYKcn6ceteiETXpyAYgIxzUIz8eVLtIUWak1qM63uPPuvSgnT3NpkWKuRBQlKBRKKmROUqsu0+w0GRroIeyEaKORUmN0CibO/DXjdpMSY+JOQrHQy/RKlaeeeJV8AL4f8MQT3+YD9z/IzPkL7LjtNuqNKgdefIVCIcfWbZtZWlykXC7juVAqVqjXmwiheOCDD4jHnnzGeeTJzifH1126eXC4cNfyI6dHHIGnEjETae9QzYjHkGquVCwQCdBrbEvRvdiEEG87Xf9GnbZrn3+t7Hm99d3o8+34P9jxb1Q8u1H593rrX/P4zwNPYC6nj1WAg8C/JpO/fljZAHwRuP8GljlMJuRZLBaLxWKxWCwWy3uGFdQsFovFYrFYLBaLxWKxXAcHRPHNHzYRXr5E0lhCiZRHv/F3g5vXqY8MlAp4UiJwwQ8YWD/CS4efY3pugb27d5ILAlZqDYIgwPccGvUGAIVCkdmpS3zpS89w//2b6e/vx/M8MA4ChRCKWq3G9PQU27ZvIk1jpMxdMymN1gk6CUnSFgYPYwQCiRBkn5CvqS2NMWgpmGlB3N3kVRdK0611BAoFKBckI319zE0v0E5CCoFPTsTMXLpET6WMET7NWHPi+Ekef276D267/+Zf+NqTB0kFKJOgTCYuZUlXmagmBdkvaLRYrbLMav8QXUlKrv7T1ZGkBAmxhNDJZqrSrEJVIkm0QbiCvoESJCt4KqXTXuI//v4zm+9+HzfPLpyl2VlkdhYqnsBTBs8Hx4GRsT5WVpZIUk0+J4ijCMfxOXToFH4Am7e5lMoKndZwXNFNHNMkSUScGNIUdAy0QYaKqGEYKIzSXpGcODjN+ZeOkm9VGG5vYbBviHIbnDjN9rcASLJdsCaBTAuNebP+tmuFA/N6He0NpQShr0pgQ3QTsGT32Kwm812unBSXfzdCo6UGA8o4WZLaNeNeFjHEtQlq727F3irmsoaXlYhK7aASj5LuoRgOMjM/y9yzM1y6sMzATQET+yYYGC1Sn52j48a4JUO+oHBEAnGMSCWOFOQ8jVIKz9F0wg7rx3u5eH6WR78+wyc+NYgxEdJAGKaE7YSeYhlyOerLDc6dO0fsGloRRB1oNyRDA9z8X//4mU3/5H+5/7SIQTdbhJHAz3tU/F5ikaVzxalGCAko0BKVrApqXL5OBAFO3PVHtM4ENR0glJtdWCrrz82S7SSxcL50/PTUNy9Onf9Cf0V9urfsbfOIhU7Dguv7ADiuy5Z169i8eTN9/UM0ajU8z6NQLDA1NcWuPbvxfZ9WM6RerxIEAUZ54EKz2SJf7KPR6jDY18/4yDrCWhNpJPVqg3K5TJLEaG3wfZ91k5M0FueoVpcpFT201hgdo00m22kjwCiMSTFEJGlCrVbjsUefY3xdnvvvv4/pS4s88fgBRgdfZXLDJPNnT3P7PffQatd56aVXCXIeQ0NDrCyvdK8NedU5uGPb1k1HTx753d17d/yUX+j92+GxNp5wcFNJagTfPvTSVeeZ7opowqQ3VOxpsfww8TZEuENkiWJ/eM39v0Emc/08P3xpag+RzfntVnpCJqc9wI9efanFYrFYLBaLxWL5EcMKahaLxWKxWCwWi8VisVjeIZLp2UUqfkohL5CGnx4bGqSnVEbg4OZdKmOjVKsrPP/iUTZv6mNicj1LS3XCTkR/3wBoQ5Joenp6aNSbfO2r3+KuO9axc9tOqtUqoiAQUiJRgGR2dpZGo8Hk5H5anc5VsxFd+Sw1MUkS0mq1qFQql20hcdka0kgDqUzQTkRlNM+u9XBqFhoxa+SoLD3NA3J56CkHzF+aglBQNgM4kaQZz9FC0Uok89Umx07NR+fOLf/K/Q987PeMp0AcBJWgDah0zWTN6pwFQihWU+rWfnBukGghMThdOWptnaWDFhpJhBYaLRISHBQGRzokukV9ZY5CfoQ//7NHHvA8fnz3Lj7bW4LFuUXCGBoaLrUMpFm7oAEGh5aY3FSit1+yUq1SqZSo1SPOXYRNm6BUKpDqDp4j8F0PB5CpIU7qxCGkCSjh47n9BKqf08dmOHV0mforEcFSgW1ijDxF8CToDkarzAq7DkK8mVFw7f1vM1JHCJTIxDMtsvVr1T1VJAijEGhUd59Lc0UQ1IDsHi8jQBuJ6qapqe5xVV0HSKu3N513FwlGkgpJ6oDAZywZoa9WYnp5js6FhEPfrVOcbLP3jn7cnjqJI5hvV/FyUHQhp0LQ2RYrR+KoCOVqaisRO7fDwYMwcy4iV+wglSaOJFEIr526yNwMNFsQFEDmIOm6fnGk6avA7bfy+F/91ZN/0azxtbtvH3+ilB+g2a4hZYCRDlI6OAISFIlWgCLtptFlaWK6m54HiOxa1shM0hMSgcw6eYXGkRIhDAaHWHjk+tdXy33531yqzv7mwQMzuWiB/+2jH+KhvTt3MTQ0RJQkBEGAVJLaygrNVpMgCOjr7ePUqfP0Dw1TKpbI5X3CMKLVSujp6cMPFKnWNJorTM+cRyrwykU61RVqK8t4nkcSddBaI4SgXl1mZrrO5Ppxzp49ztnTS9x+5y0szq+ASBAyBSMRJgU0Bk0ctnnqqWcZHx/kvvtuR6cJ4+MT7NvX5NHHvsvnPtdLpadCdWGe+z/8IR7/1jc48MJhHvjA+6lUeqnVauTyPiAv16X2FnLcfevgT/67/3jsU7/0y/u/2o58fCSBbmFMjCTq1rV2d75YrVA1GGOQ0vCWqto7jfC6zvLXTdCy4/83Nf6bispvd/y15+raJM41P9cs8kVheAD4uWtWso8sTe2PyISwH7Tc9RPAbwOTN7jck91lf9Dzt1gsFovFYrFYLP8dYAU1i8VisVgsFovFYrFYLO8QSa7US6WgWFg4x0CZf9xXKuMqD6NBeQFRO+TcuXMIAVu2bCGKIxxHIYLsrYkkScjlchQGBnjkq1/FdWH/vv0kaZqJIlIC4vLnyvPz8wyPDCOEwHVdkmvaR6XMqiXDMCSKszpFYUDrBKXUZaEFoREapHBYNzbMT38m4s+/corjp8kqPtesMwAqHlTyEtlxCEoDnD2zwouHDrBj9wiDE9s4cOISh48ucHaq9S8//pGf/b1q7NJeqhFRRJsO0mTJW6nQOGQfgiuyBC5Wk93QSCMvf1CeJYnJrnKVXHavlMl2h6M1Ap2lmMlM4mk32wz1ebSrVY4dW7iP5JF/f9tt3LZl8xCDQwU64Txx2iAXgBQeRXcjzRXD4uIK9XqV8xdCqtU6QyOwecsgpHkOvXgO14Wdu9bRbK3guAIv8FBSoRNDkiTEscSEmhxl6rOG2TPLdGbqTB2pU2oPsDXezkB+ENVyiKKISLdIRYIjs3pAIW+wq+1dQJhsX64OLbpz0V0ZRxpQpqujSdDdilUpIpTWKJOl2Am6coM2yG7ClCQT36SB9B9+04BM2koVCC0JkoCC8JgQOZabbZJOh7DR5OVL5xnY4tG7vUQwXCSOVmj7bZSrUQ6kUpLoGOUYXNfH81I2rJ/g6MsXOPZylQ99fBdL8xc5eaLGhfNZCt/AIExuLODlAvIFByEMys0SwjpRghBqfbvd/henT6/8izOnpg68emTqn3/yU3ufarRihFCXFRJJVumpkEiTXbcSDUajSWE1vU47aOlcTt4zaYh0IhTgkEMYJxNcjUQ4ecK2wPV62bJDt9PFuc+//773U+mp0Gg06ERR9rojBM1Oh3arTV9fL6VSiakpOHTwIHfedRd9vb3EcUK9UWd6+jxTU7NUV5ps276XOGkTRgm6ucLDX/kyS4tL/MzP/AxSgeM4BEHAhYtnePTRR9m0cYK77rqD586e4syZM+QCgeMYkjjOKkVdH20gTSOmp2eI45RbbrmFer1OFEWUSy6bNm7i3JnXePXoKzzwEz9B87XXaNdqfOCTn+bxv/kKTzz+bW6//TYmJsap1WqXxRxpoL9c4uabdvHRB5/8L/mCN9BoKRI8EhMCEYIU12hisvRH0RXUZFdQS29UOLJYfgh5AzltlZ8H9pNJadfyc1yRw36bf3jR6wGy1LQbqfNc5XfI5DqLxWKxWCwWi8Vi+QdBPfTQQz/oOVgsFovFYrFYLBaLxWL5UUaEnDz8HQI34g9+75Htt+8v/Jvbdu/BQaITRZwaCusn+M7fP0KxKJjcsB5pHCQuvhcgkARBnnKpwqWz5/nOtw/z8U88iDHgeT5+4KOkQBiJ0A7CCOYW5yiVckgnxfU9hHFBZ3KKFALfc4mjkDNnztBpt9m1YydhGKKTCNdRmUykNSI1iFTimhweim0b+rn/zhFu2Z5y9x7FTZMdto/Bvq2wfxPcswc6tTmOHj3K0VOXOL8YEnklGtowtSwZ2/pR9t75M3z90dd+d/2W9x3vxAFOYZAjp5aJTB+J6SUxRTQ5UnyM9EC4OELhoBEqRWiBMB5CKJRKkUKzcWKcnKdIwjrSdAhcCFyBiSPCKKQTJSAUSjqkWuN6Ds3GPCdPzH7yjtv41ic+vm1s/bhPPp8gqVGpSIoFQRBoAlcgSPH9hJ7+lOGRHBMTHrVqhzMnYWG2xVB/P8eOLjMxAb7fQToG33eQSpPomEa7TSdM8YJBVqYM0y+2WDkQ03kuJTjus6E9yXC7l1zHxUQhqe6AjDAiRUqVCUZCYAxgum2nV3E9Aeb7TVBbXa/JJDUMkiwVTipFIg1CgqcTdKppKR+dL+CWCoRxBz9uk/c8WlrQAbQ2WXtstwnUSNEV3brCmhBk/4F4j/9bTREzUqGFg1aCRAkiV5N4GuUKCp6ipAOKzT7CSwGzJ9qcfmWWUmGYIDeAcH0Wag1qDYPjglIa15F0OilJrOitVDh7ukFfpcCrR2Y5eQzWjcOtt/cyOORRLEuCfIrjaBxH4yqN68S4boyULRwvZKDfY/eedWNhuPKPn/7u7IsTE5UTWnpoRFbragw6NqStDqoT0ZfzcXSING0UHVzh8trRedA+UdwGbfA8hzipI80KxYLEMz6u8XGMg28cSn4e026TU4KFqbO/etu+9f9ocnIMkxqiKKaYL+I5HmEnolFv0D/QT73e4IknDnDnXZsRUvHS4aOUSnkcx+XM6dd49rkTVCouW7duZXh0BK1Tms0mL7/8EsdPnuODH7yH8XUjaB1jSECkOMqhr7/CyePHOXPmJJVyiSDw6O0tAQYhNN/73iEkDj2VMrNzFykUikxPLbBubJx83qPdapMPipRKZbTWnDt7loFSniAXIAQ0l5fYunUrCwuzvPzKSaKwyejoKAhJEsYIozFGI5XE9UX+uReODI2NbPw75RaJTIpyHOYvTXVriLvCoDE4xuCmBqUhkdcTMMVb/JVJcpfD2d7gZq5d4oZlTzu+Hf8KqwKaEYDJceZUB2OcK2La6wLfBMCfAR8DRt5ggIBMFPul7uPHeO9FtZ8Hvgj8KrDhBpetAv+ITKi7LnFX8rdYLBaLxWKxWCyWd4pNULNYLBaLxWKxWCwWi8XyzjCSBJdqvcme3fzPQ/0FHAkilqQGvFyO6oULdNodNq8bxWgDkm4qGpjVtCnP5eWXXmJgwM9EHrH6uMDo1w+bz+cBQxRFuCp31WNaJ0glGB0dZXl5mVqthtbZh6w6zWSMq0J/UnBkgqTBZH/KxL2bSI1CJzGJBuUU6a1UqC/Oc/LoMYKeCpH0aCmXVPgcP34cz+vnwY9u4+JcB09HtbixTKmcQzkyq4bUHsqAwkHioEyCQiJEmpVGdpO2tDHoVCO0wJUC11G88O2nVNThp9dvCD7p++5W5Sixslg9Vq+aL++5/bYvmRBkLgBjMEIjHcmhg9OjH3q/89X33bmBwK0jRQslUoRMEWmEUHG39lCDrGUSgNBgHIxIufX2cTZv0hx8cZqvffU0xTJs2FAijOuUcuWs0jGJSBPodBQ5McSRxy4yfdjgXIDBdsCIHqJX9OC0A3QqiVWSVapKgG5l62qVql4TY/YPjOlWRbopoDVpHBK7gsiXJK7P2WoHUXRZTOaZmj5MsVik4pcZ6emjIHIYR+MlBjcxEBskJqsLld1CVnFFwqD793uNXq2PReOYhARJqjRGJGiZJZHlYwAfdEAgJEHaRz7u4+TfXMAdSxjZXWDTLduppmcwOkEgSFNwXUWURuTzAcqFr33tLMPDcN/7C7heiutphExAdrLkNJyswlZk1ZZSaVzH4OuEWEmidI4HPzZJbM79zVe/dnLs45+6eXo1zUgazWCxRGAUz3zrm59bLud+qq/i70h129TD8ES1ztfmZvivk5PbU60V+Vz2WqBQpCksV5v0VXpQOrvmBYYkauCrhJlzrzkTYz2/Pj42DECcJEgpKRaLLK+sEIYhhWKRer3O0aNHKRRh185dGAHf/e53OX78BEtLLRBw992b2bRpC1Go6XTqDA724rkely7NsG3bMJWeApDg+RKnUoEkpWxSknSQ8fFRypUio8ODBDmXZqOO40KxlGdy/SSnT56lXC4yPj7O3NwCruPguC6u6+A4gqlLF9i54ybGxkY5fuwYc3NzbNhQIElSjDHEcciHH3yQZ599lmeeOU1PTw9Dw9k2tzodXFfie3k2T4zRqKf/5OG/+fYff+qzH3+22vFpaZeEApgIY8AYyWo+oDEGjQET3Xhto8Xyo8UKWVLaIaDyJs+pAF/o3g6TCWQPA2ffpTnsJxPTfv4t5nA9nuwuf/bdmJDFYrFYLBaLxWKx3AhWULNYLBaLxWKxWCwWi8XyzhCQGsU3vvEtZ6TIL6wfG0SiSTUI5VIslzn0ykHqjZTRsTGiOML1rxbKSqUSC7OzVKtVxsfHEd0IrVV57cpYGgzEcYcgGECqmDiOUdJcflwISZJGgGZi/Trm5uaYn5+lp7eM5zjESYivfIzUaKHRUqNFBCIC1cFogUkNQhjcnCZwJZqIWmMGHSVs2biBSm8PqYrouBEpHrdufT8XXpvl8T/5DbSR3DE691tTB3//1z/4sc88gVegaM4CGmUyWUiZBFcnuDITdoRyEV2JSToOrvIxGpK4RdJOPrN/89C/vfeuvZvyBYlys20NnPy+7x149fNff+rAveVN27/gKp9UaZRIMaZDkOe3duwaoFBsk5MpjlFXJBKRZlaWNllqGXGWgGQkGKhUSnTadbxcwu69Bf7m4SaVHsjlA+JmHSkhSVJSHRNHHh4bOPrkHOe/adiU9LBOjhNE0I7rLKdVPAnSC0iVZtU1lAYcIy//nrG22BHgDczEdxkjsgQoYcBLwdUCv1SkoVLageZSEPCiEzArlqj0LDNyRwGnWODwyWW+NeMy4VfYolqMmYQ+6SGEQabZdiQqG8PV2frlW8zjnaKNQa6anFJlNZhoZPdfIUBquqlkIIxE4qCFpuO2AEmxE1Bu9zGU62fm+CxT51eonV9g24O9yHIdHRmk4+C5krAd4udDtIAUuPf+ARrNFVxXEAQmu1a76XFCxyC6KTzdSlXITjfH07QaLdBz3LRnmAsXZ39zfnHuFyqD69EywdUa0ary7FMv/M6P3XPrL+/YMEopJ/EDQT1a2j+10P7cofX1h7574LVfrfT2/GW7GRJ1FF4uIA3yxCYm9HJgBMIYXN0hL1NqK9MsVZN//pGPjhfWjQ+iMERxTL6Qf92+nZub47XXFvjEJ95HmqbEacIdd97JwuwMX/nqi7zvvjHWjY2QxCFSOni+QxzFjK0bZtsdt3L0+QO8dvo4R4+9jDGG4eFharUarVb2erNj2zZ6enpwlUQqTVO3SdMQpRT9A/0cfeUUM5emWbd+N1NT0wgpstcNIZFSsrS0TL1epVLpoVwpcuHCBUZHx3BdB2MM6lhu8wAAIABJREFUtVqNKI7YtWsXhXyeRx97mffd22H/3puoNeosNWq4Bnq9gFs2r+fcjvMPf+Urfzd2x8f/By2cXuryAoKEDpCI7AaghEETosUKEL75yXmtvHajLts7ld/s+Hb8193H9yMKnyVLSnuC6wti+4D/0L2d6y5zaM3t7SSs9XTHe4BMjpu8wfmupUpW5/nFd7AOi8VisVgsFovFYnlHWEHNYrFYLBaLxWKxWCwWy3VIgBYQXbmrW8WY0SCuThHI+Ffuv2d7sRAU0CkkaYIfBFDKEccxnguOUmjS7nKZOoOA+flZwjAmDENGRkYy+aKbpvW6ZC2hSXVMmMQ4RqJ1mpkuax43BlLdoVDIUcg71OpLlCt5pOthjMGYLOHKiK6wIzRIjTASRyiQLsYYOp0QEyYo5SJTRc7P4QuPuNUioUXi1dA45Mwgt900SbNaQEjD/l1D73vs6UOPP/mNPx25+Y4PzuZ1rSsoaSQaYXS3TnLV4XERWiIUkCZcvLC0qbeXnxkede7t7yn+2PBAnrhTo2dkiDTu0Gg06MiQO2/fQ60d/vJTR07+q/HS3qr0fGKj+d6LJ4JbbubzvT0ujcY0Pb1llMn2tTFZbWJq6O43jVmtpOzuP6ESjGhiZEqxnOfOOwpcutRkealGUBAkiSFNNXEKtD1WjnaYf6bBeHuIETOM23RRAvy8QfsGrSWp0ZfFFuimxYm1ctrqOQFSZ2luWoARGqO754xUiK7gZIC0m8QmtOwuqdfcJHQ1LURX1uqeJ8JcSU2LpSaRmo5yaDpFYgLCYoULacjJzjIn2imv4LJl/1b231pi2/oOS9Vl9ty0h/DVMgcPtphOKoy4PoNS0u8bKiYm0B08YnJJgh9qXJOgu+dcIuke/a4o9hb+RZa8ls1/dXsxDtJIhNHdbQNp0my/CE0izJp9K7O9oGWWXLi6d7qSWnZfhDQSP9XIyCNuakYKY3idXs4dfpnSZp+hggO5GJ20yXk5PGMIoxZuALfcBkKFBHm6tZdZLV+qRZZaprjsGhqu1g+FhIF+WK62GRjsY3KSz798cuqf3jywPvSTrF71sa8f7PnIvRt+edeWCTxiludnGByu4EtJoBIGBtm0ZYv3F2Fc+2azoZ+ePpv8ydBo6XSxUCFysvNIC42jZVa56mnOXWqpdRP8H8NDOSAhTszlVMdGo0GxUMB1HKrVKq++eoybb95ET08Pl6Yv4edy5PN5mq0m/f1QKhWI45Cw3qLc0w8yJVcJiAmZPXuC0eF+1o0McH7qPK8eO8o3HzlPqQi7dmzipt17CYI8xqRAB5NG9PcWWV7uoJMUR8PwwCDT09N0OpsJwxCjBTrNrmWtNUrB7Nw0PT09TExMcPz4CRqNOrlcjlwuT74Q0Gl38HyHzZs3EycJL790jFp1mbvuuZtclL2W+kAlJ/nAPbuHT1868tcy6Xw6TprZcVu9dk12rUkjkVqgTJqlqgmypMs3kn6uPb/F9+8cGd5kjOsuZMe342fo7guQBtARgQFM57IOvVaLNgZi4aCNt3rXIbIks4fJJLS3wyTwc93bWg7z5qLaBt6ZkLaWf01W5/le145aLBaLxWKxWCwWy1tiBTWLxWKxWCwWi8VisVgs16HFv/qVn8RjBWk0rpC4SNJORKAcPBVy9tSR3PZJ96HxgQECP0dtqUZfpQ8351GbnqJWq9HfW8akmlKxiBQ+S0sr+L6P1jA6NMqZM+cBSNMUZFYjl2lckCZpt/YzYXpmCt93cV0fgUKkKcZohNBIIYAUQ4pUmjBcwdDi/Ll5dm7fSq1WR0kXrVeTyyQCRT6fZ3l5kbCdkPc9+ipFjEnxuklqYdTGxBrHkTiOQ87Po0WOUDukRhPpmMWlafKlIn1Dw3RmFslV+mi9Ni3H+9Zz9757s3QrkaW2FXsLLK4sEqYhpUKRkdIw5UJAO1zgsUcf/alPfXLdl/betFkVyoIk6jB9doknn32e/eEObtm3m4V6g3IhoBnV2L59hPMz57/50jOHPvORz9170S+PcfzoK7f39QZFbVI8CUncwJikezw1XrGAk6aEcUQaQ2FkGMKQdqtNux2SmAjHBy8PcQtGR0a4eP41kqgAQYCJARSByiNbJS5+u8qW5XUUZBFPu6i86mqIPhidVXkKg7vGLBAIVkUyIQRaSFKRyVqym5yXSk3aPZ50zwdXKNwkkwpDJxO9vNTLhAfZypLwIJO4yCGAVIUgEhztorQkH3g0O23ascZIiVMKmBc+J+QQp5wBXqHAbKHESl4R512UUiwXT5MvzEL9NCJu4nmwa08PZxtFXmjcQ7M9SNC6RKU+w8ZkiZ3FPNtczVi9ihvVoFkjcRJUsUDkOKTCAeOgUgepDUq/Pl9NCIEkwSEFkZI4Co2LkxQRWiDSEHSMlhqFABmhRUKkNKkAYRykMSjjAtm+1VxJMJPZRUYQe9nvIiF1EqSSyCSlYjSjuX6OvHiR3u3jSG+KvgLopToF4bG4EhFGUOmFNA3pqfTg5XxM1CFJDcSZMKeki+MKUq0hjUmJ0Bq0hqT706TgOA3cgFIUc3t/qfc7Fd3hL7749+v23qT+atf29ZTKPovzK1SGhlD5gL9/7Js0oxYbd29j845dJEn0kXYr/cirL1/6jZNHlj/72Q99/q9bxnAunkYrgaxKdBhTDWdIXf7Z7n2Fcu+QT1xrI7WPEpI0SUm1ZnFlGWMM3/zmc+zYOcTOnTup1Wo4Kns7VQqB53kYA8VckbyfJwpbhEmMChxilaClIU0TqDdxhWRkqIfFlT4uzdTYvKGfTRNjBI5gYX6anp4cQUGTRA2iSBO4oNshBa9IdXkZz/PQq3XIUjEw0E+c1hgbH+fihRnm5+fZtm0bSZISRh3m52ezlLeFBWQMnueRpNnr6L59e/B9l2effhlHvMBNu/bgyUzqFY5hYt0QH7hr/lOnXvvub23eccuvX5SXKPSUEYFHGCWkqcRNPdxEIQkIesbQcjVB7drUwzfODXwrKXNVusyu46uX129LTlo7Bzu+Hf8tMA77f3Y9b/YxSUf08DtffIoQb+3dZ8lSzR4iq/P8fnm7gtv3yx8BD7VarbPv8TgWi8VisVgsFovF8rawgprFYrFYLBaLxWKxWCyW6xDhiiV8FlAGlIa8dFmuLdA7OEyrvkhfjj/cu219vq9cobq0Qk9PH612B5loipUyw8ODtDt1fN9ncXEJo10Cv8jS0hJxnPLK4SNcvDhLELgEQXAlQa2bhpYkEb4PURzi+y7Veo1OOyLwe5Ai5upMJo3jKqq1GoWcz4aNk3z3qYMcO3qM7Tt20mp2SJIEx3GQUiF0wuLCAsJA1NJcOPMagXcRz/MYHuxHSigW80hfIPCIo5R2UkebCCE1Rhk8z0F4klgITp6b4oXDJzn8yvRvffTjPz69uDCDJMlm2E0NW16qEqERno+RimLZR4mEv/zjR8fvvHPgrz7w/tsoFAydcImWTtixezO9vb08/vhzLC3Oc9vttyGVixSG3orm0w/ecefY8NETL37n6f+8HPO/5kvkPE8hhUBrhZcvo3RXUBOQRilxogkjRZJC5+Icnufg+z6lkkNiQuIkIYlBOVmdopBQrzUplsqkaYIxTraOqQ5cMvSHPd3aQUEiLxd5XiUYXJWa061r1QIELgaJ1E73KBq0iIhVRKJDlIlRrk+uUCbwCrRnlsFoUpFikBgcDCCE6qbtaSAlTeNuBWUKxhBmsVMsteu4vSWajuBcO+TUimYqV+J0sZ/XciNcKo+x3NNDlPcRRBSjBmPOJRARDi2UCDGihlALtLwezhTHWChsw09G6e1MU+3Mc3LmJKMLS+z1C9yUkww7LkXRRpAQ4WBShWNAaI00ilTIy9W2wOWkv1QbjNYkGBpExMYwVBrCNFOSTgOdhOAJcEU3Hc1BmgRNJu+lQiKQSH1tnWp2DKSRyHTNMZEGbRKEMXgp5CMPuQjzp+qM7RZEicERYERArdnAcaFSyRPkQCqNTtskOiFJE8I4QqcS0wSBRLkCJR2U6yEdjetKHAG1RguDxvUMhTw4kPu7h//O3Vjm/7z/ruIv3nLL/lwh7xFGTYqVIm4Q8Jd//dcIAfd94B68imBxZYah/l5Uv89Y36gyzee//Pv//g/W/eIX/scpT7Rpx4ZWXdBX6uXJpw85G9fxG+snxwjDEMmVymGdpHiBRxAEHHjhAM0mxFGM1ilSSVzXpVAsohyHQj7PzBScOHqGm266CVd59Jd6mK8tI41BK4MOI5xEIFQOIYq4qowERoYmGOzvIw4bFHyDTtt0WhHaRORUjpxfot1UTM8vs7TS5La79uH7PisrK/iBg1QCk2jiKEIqaLc6RHEHx1GUyyUajQb1ep0kzqpVfd9HSUmqNfPz84yOjDExOcsLL86cc53c5JbNk7iuIhUJSRxx6007yakL//Lgi4/OVwL1f2HqJJFCGYVjXJRJ8IyDRBOkCq3frI53zWvB94Vd3i7/Xi4fgei85RrUG9+9QlaZ+TBZbea7lXb2TqmSzekhMpHOYrFYLBaLxWKxWH5osIKaxWKxWCwWi8VisVgsluugQSRkH+RmwtH09CyjAyMIfJaX6j+3cVPv5ycnJ1FI0jTFzwVESUKSRLTbLVaqKxw9uky7822CwKNeiwlDQ7kc4HkenspdNeLlek+TImRKvuAglWFxaQEpHWZm5xgbm6S/LyAxAqNFViPYTV6JwpAwjHGEJI4iqlU4e+4027btwPddoihCG3CUg5GSSqmM67oUcyU8L+Bv//YAQ/2gU8Ol6WmkhHWj65iYmCTne7iuAARIgUESG5c4MSzV63zz0ec4eTr9xU9++sf/38i0acY1UidF66xyEiCOY1zXIY4My9VZ/uTvv7N1qJ9fuvf9w58pFT2efuopCjmP+x+4m6g9x/LiLH29JT74gZt5+aVXeOngyyjlUyn3MlCp0F8u87EP3pfbd2/0hT/480e/s9ziy4mWqHyJwFXEwmNtQFc7bhMnMVEco3WIkiGJiWmFMUZDvuDx/7N350F2pfd537/ve7a739u39xUNNPYdmAFm34dDkZQ0pCyKkbVGdizZsuTYSmynKnElLkdJyVXyokpixVREWRRNUrtEjkgOyVk4O5bBYAaNAdDY0evt7e73LO/75o/bwCwcckiKieTS+6m6c3saOOfec+57Tlehn/o9Qnq4jkEnkmwB/DSsrYeMjLFRL+gQtgLOn63QL4duhdMcKTHG3Jr29G0JDUaiBEjt4qgUAMqNid0OsdvBmBbSKBIEnbBDLQoIMoNIacCtgkrQiYdONKbbCQpCIYTGcbtryZEOiACTdmn5Hsu+5Gx9icu6zlLvZt6QR1jL7yDJ99AOMrRdB4RAaI1D8k11dEJ09yuNQApB2IkJPR/t96FTOSIxQWlkP7PVFU5VLrNZLTGweJ6DYYdDhR5KIk9WGVJJE2ESQmFItOrW2d56DYGQDsYJiIWPckH7AiEk1bCGqxVpqXE8RRgIEmm6FbXaw41TOAJCR79Vzbhxrr9TN8NygfLIrUF9uoYzVaDhN/FTGSDHcqNGOgvFUgHHqRPrFipJSJKEJIFODGiFKwdwZBaMJkEhlEIahTEKIzS1MCIxUPDTpFI12jW+um0s/6MfffTAP+pJO2Bcoihmfn6NWq3GwsICpVKRO+68HelKZudmyRf7WZ1vM3dtliiEcqnI1Pbai1968vf+4FKN//Oeh/fNZMpTaGMI1/hfDzwwkh/sHUYlMeJd4ZVWs8Wrp14lUQlHj46yvr5Ckihcx8VJObiehyMl9XqDfA5WKm1eeekN7rxjP1G9TV4V8BIJ1ElMQqqQJYx8ao00SwtpZq/B6pSLnjCkUob22jr5bIFYw+J8g1gpsukc8/N1Xn/9Dcq9JTZtniTsdGg2O6RSRVxHoBJDFIW4jkurvUq71cZxJT0bVaRLS0ukUil4V0it0+4Q+Gm27djJuYtL87//xOWfO3hw8XeP3LZvpLdcIBU4DPYXKed7Qat/99WXrzq9E96/CfJF6o0OShu0k4CIcIxGy+Cdi+c919m3CrB9p+z2dvu/yu2/pafp1nH+LN1Q2F9VUO0q3RrPT2GrPC3LsizLsizL+mvKBtQsy7Isy7Isy7Isy3ofEpW4CDeAjdBROhMQxy1On7302L7dQ586enQfQhrW19fo7S0TRRH5fI4wDFldXef82Yts31Zg554JCoUCM+dvcPzYNe677wCDg4PkMyUuX7rC8y+8QBRF5G5NkjIYLahUVliYX+DylcukUhmWFiEK20jHAEl3NJcQgAFhaNQbSOHSbHWYnj5PnECSxKysVigVy909b0yoEkKQJIp2u002lWVycjMf+QicOnUKN/DZtm2KubmrXJ+/zBvTM9pzvdmBgYHxcm+J3r48RkCkY0IN0xdmOXZCPf6DH73nz6qNJo4fkngKrRLERn0lSIr5NFpAZWmF+bmZBw8eLHz1nrsPOOlMgCsdFmdvMH9jlt/79B/xyKP3k0kViOOI3t4y99x7L5X5ZZYWl7l27QrLqRS3HzqIUQEnjp+mtsaHYsHQ4vU6J557k/o69Jbf+Yka1c2sJFH3OZuB4WHYNJ4hnQ6IwhBHdqenCeHgpw2uB41mN7ikdEzYESwudKiuwgD+rXDa923VGfA0RK5PLZdirRNRaVyk1grJ5YcwArTXRpNFOVPg5BGy2K34FBGGsDuBTwvQLtK0ccwSsa7RwSC2Fhga7yHqmeTa1c1cF1MAZDJpkiREoRBGIrTDu6fvOLAx8UxipCAxGo0gctJoL0UtaTHbqUN6hP7NAWG9xfieHaSXz3Jx5hzxckSKDFJm0U4e5ZdRIvNN56B7uSUImjiihhsv4poOnVpEMSgyVOqjHBSg0cJTdINBRiJNd+aPR7cKVQjxztq874KnXMqmTGNulfVKjHYMpXIGowOqbSgXIZVJo+ImKomJQwgTiUo0nQhUJHnt1Gw35+p2M67S7z4Lh27Rq+pevuXSIpfOgQu/uLRcP7zU0PQPb8aJWkxPv0SlUmFgYIDNmyfp6SkjcKnVagwOjBMEab709BNkggwjo+MMDQ7x4P1Hxtfa9X/8/PTpX/r6s69/8IOPTXz9U7/1xS2PP5z7pwd2TKI6mky6SBKF7zjm555/HqTg/vvuZ3llmUplEa01juMgpCCOIpxUihs35ti5s5/N4zt49eRxnnzyGaQLRmVxvRw4hk4cUerpY74Scv6a4utPz7HahmuV4yzX9nBg9xgqLvGN4+dotmIGR7Ywv9Lii3/xBJcuw+gw/I+/coROFCJQNBsR+UEH6WqU1iiV4LgO7XaLKIq6gV/fp15XrK6sMDY2hjHmHZPUSj0lWp2QQqnIjj1b7ry2dOn6yydbW2crL//25FjPJ3ZMTjAyGJF2fQ4e2EnoOb9+7OylAwuz1f+h2Nc373hZEGDQuDrCIBEk33Sd3PLutfddBCXt9nb7v/LtvzOf2nj8LPBR4PH/L17kPfwO3Ylpf/L/0+tZlmVZlmVZlmV9z2xAzbIsy7Isy7Isy7Ksb8/4qCiHEBJh2tSqiwyUMizcmP3ozn3ZP37wwYP4rsDohEKhAIDv+1QqFc6eneby5TWO3LGPXbu34nrdmsnLzDM+mqGQy9NpNdGxIJfP47kuc3PzLC5XiKKIdiskDEOajTbFUpG+8hiHbzvI4PBZ3jz/BpNTg2TyHtXqEsVSt2KyVm3geT6ZfIbTp88wcyHmJ378AV599VXOn5vh4MGDSCkx2nQrIo0BbXAQdDotOp0WY5vGqKxWePW1czz88CEeu+0o58/NcGWmzXPPVGZee332R8s9s7dnCt6RVhiPFfrd9cpKcrZa5w8/+vEHX3PTDspJAA8v8GhEVdCmW+lITKITmrU61y9f9oYGvSd++PGHnHRKUas20EmHLZtG2TY5ybFXjvP8M6+wb+9+tm7dShi1SackKorpKecolvL88Z99hatPJ2zeeQTl72DrTvFzR446eMySSWLog7YD0UbmzxhQMTSb0KxBHMGbr3cfQ4Mt9u5tsXlyiGprlUzWZWCoh7gT4Xvd7eJOjHASenv6uXx+gXoNpHSRb6unFAYcxFvTu75NPZswAqnpVnY6EQCuUeRlmmathhzexAux4bXOBW67r4jnrTKzeoHS4CjNTsLJqy0uJcM03J0AaB2jiTHEIKJu0E16RCsn+cCeDvtHIvZNZCiWNB2/ih8uUj17DvLjuKksragOSCQu2mgcXBxchNyYEIdBCJDCbEyNk+C54EiEUSRhBMQQuCASWqwxlL7MniN5jmYhuSE4e6HOQpTlktrCM9MGkd5HbMrveX5cUUOF59mcrfORzR5u/RrNxKOT6+epU1fYnozxiDdIrhURJi3clEA73fBlkHSn9iWeQn0HFXlCS7qzAbvbAzjKpT/dz9rKKs11Re+2XiIEwhVoAVECCEGj0aJaVWjlUCyNc/XaAqdeC5mf1zgeDA5A3xCkM+ClNtai0w0hZuNuIDExcPSgxwP3D/zGiTfqHL8MNe2xNP0NSl6dxx9/nDAM0VpjjCZJoLc8xuWrVzj56nEK2Qz3PXA3jXoVQ4vllTpDmzbx8P33uBcv/dHv/+Hvf3H3oYOZ3961dQRPJwReHplIVGLI5tLUajWefvoZ3MDj/nvupVQsUltfJ1EJ8/PzbNo00V1jxtBoNqk3G5SyeaY29zMy9CDzlVUaCaw24annZ/ipn/6XNFsp/u4v/F0urnSPWUtJB80XT8Mr588wOnQZaTQ/8RM/xY/81I8TI7j7oYdYrUFVQbMKa60QFYfEHYNAMDzSz7Vrl8hk8kjpoRXEsSFOEoIgYGh4gOnpi3zpSzN87EcCRoZHUFoTRx3SKZ9YdauQW1GDcn8PPb38/n0PHjoohPivXn7+5K9durj2c4N9zg8Us/5Uub+HICMYHy/9zNXl9ZdxCv9XaIpgUsRG49NC0cKl+b7ry7L+BvjUxqNEN6j2UeBBoPh92v/NCs+nN57ttDTLsizLsizLsv6LYQNqlmVZlmVZlmVZlmW9D4kghRQGtCKJlTgzPfvvbjtY/qWjB3eRzriUCgWuX7lKqlikXm8wPT1NpVLB9Rwee+xO+geHAFivrhFHya393tRoNCgUSoyOjjJz+RK+75NJZ8gX8vT19XHixBm2bx/mzg89Bo01pGc4fvwiMzPn2blzilzep9FcReKRy+VpNELW19Y4c2aWBx/cwdjEJKdPv8Hs3CLbd7TI5/NopYmjGKUVQqt3HHG73WZqaopGvcHTz75Kz8ARRic20d+fkdKbeej4Kxd/+tEP/OA/TGKBl/WZX7nG6JRLGKXJlErU4hWM0GhcpJFEBDhCI0WCYxKiTpOZi1f+ztiw8ytjYz3pM6+9jOcbdu3cg3E8tFZEnZA9e3dx5o2zTE9PMzc/RzabZvOWSfL5PGHUxBjFxOZxPv8X1/nQJw6y28vxZ1+8SP+QQxqHXMdFGJe2B/FG9SZAqdRDGIa02y3itsK5O8fKSpWZmQ6vvAwXzi+wbTts2dJDfS3ECwSDQ3BpphtGU0lEu9MglUohZXzrvN3cv+C7pdEyInY7CAMFJ8Pqeg1RGub1KMcfVjr03/kQoz8ArjdNZn2RfLmXOPZRa1O8fHoTq6nDCNJoJbsBJtRGQE2jNZSTIt6eU0ztWCOePQbU8VWbolNkMD9JQ7Yw2uuO+cJHa5BaIk0EDgijkWgQujsFTAgcIXCEwXMMQigclSBJUGgUYFwQdOjNrxO4C9TlJUTPLFsfGaOcOcqLr0+wlh+jGk2S6PcOqGW5wahsc3h/L4cnZokWQ9rSx+/Zx9pUjq9/+iR9Is3hTIlo/gIj+SwN0wAjcRIfkCTvuWe6k4SE3rgWv92ENRc/lSKVSgPddaSiNtpAOiNo1EJcWSBwI9YbbZ4+fpVWEzI+fODhAvlCmlTWI53xQCTEOkSpDogERynSkUEqQUf6xFJSHvJ47VyNH/yxH6G97vDnv/P/8FMf3YTjeawvLtLbW+bq1RssL69Sr9VYr6+yfetWJic2UVlaIZ32KRQKrK6ucezlF1lPWowOFco3rtTe3LGpr7R1agIRt1EJZFMZ3Kzk2rVrPPfca2za1MNjH/oQzUaD9bU1PM9750p9R3Vt9x5WWZ7HkS6DwyMUjM+eoSnc3A4qy1USGTC9AgmgSKN0jOuWaCZtap02y1dCYhS/tOUBygce4sGjD3JtTeAEBqMhcSCfz1PMlzh+9jTl8iC9fWUcB6RwSRJDoVDA9z3CMKS3XEatKTZvGabZmqdSqeD7Pn29faw3G5R6St3aW0ditCabTjE20nvgqadevf3Rx+46fvjOwyd9IU76nubZZ17d6l5tl8OYONPD1WaNambbGGvNAEWqu7KERBO97xVuWX/DrPNWWA26NaAHNx6TG48ScODb7KMKnAKubDw/vfFsWZZlWZZlWZb1XyQbULMsy7Isy7Isy7Is631oPA9czxAnMdIR9JbF6VYz/KPXXjtz6IxJNpeKeaJ2i06r3Zibi15IErbdeeemzXv27MIYQ6vVJkh53YlEtcatPRsAAZEK8QKX2++4na27t1MsFjFGbdRwahIizp5/jYGRIv39/fQODHD40BZef+0S/X3D9Pb7vDtg8/RTx+jrTXHb4aPgeuRyOS5fXiGOQhyZJ4kTmq0mWmt8x8XzHPRGsiqKOvipgB27t3Nt9kVeeuEat912G5msYe+hCRzf/OIrJ54qHT7wkZ9s1lM4/gSJ6JAuG5brszhBCi1cDBKFjzIZpNZgOkgiTp2+cvvddw588oMfuIdmfY2FhVlWV9f44he+ztbNQxzYu4/ri4v0lIscuXMvS4vLLC4uUVme5caNKxw+dIjJyUlWlle4cvE6P/mJgzz37KdZb7U5fMcY2fI8KRSpjoOnFQEGI7oBMg0QLxKgcANN4iuMaZIvwOAQrK3A3CwszMLS3CKbtgSMjfdTKJQJxhtFAAAgAElEQVQwep04NngBJKpJT38f2WIdU+2eeyHErZDardUjbn7Q7z1HzUhNDCgnInZbeBqa9TqyPML00DCfnY+Z3f9DXNSzjL75LA/uVmRNnWyjieNkmCgMErjL1MNrOPSi4279pNZio0NSQNIhk/JYW62TtBVl0YOoN8CDcs5hd96ntt6gqgK89BCdSHQDXjrCMRopb4bvul9LuhPUpJRINB4dUrqFr0CiUQYiV9IRLimTMFFqU3LWiXUHLwhImk20Y1hYSdM0ozRDgab9nldfMZlju3OS/SZBr1VIOhW07qCLm6jntjM7IvmD2Tamd5DbZIv15TdxervbKlVCaL/7Pzdr7m7V28m3LsL3CKmJjYl42hG0PPB6MmQLaRxaCKWoNzsIDcVSFilLXL9aYeZ8xPIKbNkCk7dnKJd7WF9fJZVycNwYz+tWjUoiEAlCdCe1OVpijMAVBi1j4s4VdmyRfO2p/xtfjvATP3mE8yePsWPHTkZGhlldXePMmdfJZQsUSwFbd2ynUCihlSEOXTJBicsXlzh56gX6RorsOHSAp5/9Bo/cWSwd2rOJZtjBEy5510NGERdnZnjl+Jvs3DnMbbffRrvdwHEFnufQaL5HvG/jXIqNyt5SXz/VtSqNRotUKkNzcZ0jW4d4+oU/5fjZBSZ6YbYG9biNE6RIZ6HdjCGEGoqUB196/qu8ce0izxx7hm5EEjJZuPdImqHBEtevXef48Yvcf/9+PA8SFZPEAB6OK1EqZm72Or29Jcq9Zebm5xgfz9Bqtjh79ix3330PfX19VCoVCoUCnnRRKqKQ8SkXA3oK/GrYaj7mBEVacUIj0hx55MiMIOH6zCWWVwx7d+5gfc1HuWVi6YJsIXDRQt66xt+x1r6V77Fu1m5vt/9rsf335srGw1ZxWpZlWZZlWZb1N5YNqFmWZVmWZVmWZVmW9e0JSSLTNBONoki6J2t0VPukzKU+Obu+wtVLN7b2ZBoFEsJGi/kf+9HDq8dPnPy0k0pv7sQxYatF38AoWitarSbpVJ6bU5gApJTkc3k6nQ6pbIqBgT6Wl5fRWqN1jNKarVsnmZm5wOzcdbbs3I4OY+65535q1RZf+cor/NDjt1MsFRAE1KotvvylbzA21su99z5ApVIhHXgUCgXS6ZuHJFFaEYYhrVaD0eFhjDY4wqAwBKkUUdShp1xi795tnJu+QXunIUqq5Espdu0dJYqSn/i1f/35E7/43/7tf5Mvj1BZuELGByV8hElh2AhnCVASHAOYBEHEYD+/sW/3BFFrlYwv2bFlK62hFsN9S5x+/Sy+K9m1axdR1MGYGC9w2Ll7N9lMnq9+7eu8eOIEV5fqKFkiO7Sd8c19NOIr4NTYMj5OrNaRxECMEeC8LRlm9Mb7kgLhSISQODmX2kqE50GxB/p6U7SagssX27zyYkirdYO+gTKxhmozZDDnY7Sg1JMjk3dQAiJh8ITonse3z1Az8lYwTd88J3QrHZ2boRahEUbjmQQlXNTQKKfjDJ9ZrHN1+z00Jg5Ta+U415lmrxHk9RVke4Ws32Eiv86jWxW1Ny7Q8HO0gzIqdJASEAYjHIwQGLfAjRXD3LJiKPBRqjv1KScjJrINzq8t0UyyCMelYwwYMAL0xrt/a70apNp4z0JgEoWnNY5MusEHAwiBxEEYSaAjBoI6ZXcNozs0OiE9fpblhXUajQytuIRxE7rRwW4lpzQaQYJLRF5VeHSPw47CLCvNWbysxHezzDVjvnZmgfWxQ+hCwm+eOMY/Hi6z05lAqzk8ExE7EUgwwmyEqW5+Jm732AQbrweC956kpiQ0/QRVlHhZiVIh0oEkjFAKMqk8r548w/wN6CnC4x/uod1aw+gWnUaLvmKGIOheB0YYDAkSjTbJraCINg4aF0ckuGiClMuRo5s4fu48AyOCsdFtLC+McPzNywS+y9LsNYJ0wAOP3UsY1UmiBsK4uCJFuTzMqydfY/rsG3z4I4/SN9zLE19/EkLDwX2TjPblWOt0yGVLLN+o8MbpM1Traxw9uoNt27cBEEURURTTbrdQ6m0TH43XvYAwgAIkWsB6vUEnVrgSsqk0a6s10p7hoXsnuevBIzx3+pMsnQkJXPj4xz/E+fPnOHVqFV9CPgdH7n2QJ599mrlrn8UXoA0Qwt6d8OOPH0GoNi++eJzqOrRabaI4jZAarQWO49LptGm14Nr1OSY2TVAqlRgbG+Pa1RvsP7CPS5cu8dJLL3HHHUcpFAokSTf8K6QArdmzbQKVJB945vnT++66/+7Xax1Fua+P5eocQ309VFsSP9dLNfExXp4YH4ULaGIydChj8L/9z5F3+6sJCVnWdyWk9G1nS1qWZVmWZVmWZVnfORtQsyzLsizLsizLsizrfaT4X/7tZ4CkG84QeiOksfEwtZnP/9o/xKOGEpLrTc1KRFJXDonQ4IpuMC2dxREZtIJsJo/R86yurTMw0EeYxCAFcSQJkw6u75EkCWiB0RopHbZuneLNcxeZmJihVCrjOj4f/siH+L3P/C5feuI4H/nB+4E2T3zxG/T3Zzl6xx0EKY+1tRaek0VKSau5cUhaszi/wMzMebZvn+pOyBIghCSd8hBCIlwHHXaY2jTK3PUFXj99jPvuv52w3SDwNVu39fKzf0f++he+8JkvjO+784LMlKi1fdpRCi1CpJOgnRZGJkyOT5LCkDMpPvvJE7d97EOZO3NeQtRs04gS0qkQgN5SDw/cfydf+OJLdDodJienSGWyOEGZZgQIhXB95po1FuYq3PbQJzg4UmT6xP/Oow9P0mqsoVuX6Qk0UgBB93BvfWTQzSApgdGCRAE4uApyQQ5SDp1OQjtUZLKCHbuzjI13OPGq4vriKg0F2nWBAEeA8RzShRQL7XUybi+OcRDJW8OUtAEwuEZgBCSOJNlIqzkGvKQ7hUpubJQyaVbTJZ7qBHwhcjg+vpPm8FaWWisEruBEc4TeazE/u283XH2OTrNJj3+DnxwZ5epLZ3mjvIvLoQERIujWbRokuGkined6s5eLtVV2TUCfL/AMKKfGSGkF71KMGwzQaNZxlYMRksTRJMIQGNBKUSjmkLFBSMjl8tTqEqPAUS4ISeRGaKkJaxFevoA0hvbaInvuSpM3K7QxRLGhKRPW2zHrNZfEy2K8GsgItA8YtNbIuMpYPwy1l5maVMThVXSqw0oiGR7Yz4ljHa61S6z6Q2SHMmR2G373xhkeTw9yoB3Rq9Zo+x206JBOAlwtEbr7T4EKUEISb3wWgeoGBrkVUntL4sZcC+cYGclj/BgVRyDTaJEmSdoce2WeUgH27JdsGRskalUZ6MnguIDrdWuBWy0SwPE9jDQgkm7gT5iNiW7dCVxSChACZcCsz/Ezjw8S6Qxf+9pJHvxbf5trCys89aUnCELFUNqlYWosVK6xbXwX1coa1dZ1rl9/gatXV7njrj1EUYc/+twfI1x45I6jDJVyzF65QiNMOL0yrY+9vriUSlF6/MP3pXqLaer1KqVikVhpjEnIZNMsL68ghSCfL6KVjzEKLROM0ShjUEbQ7rRRGlJpn2qzSiqXYXl9juMnn2Jy9z2MDfXxyqlZfujRQ/zub/5b/tk/+Sece2UaBWydGOUzv/ef+emf+ftcufgnlES3DvTeg/CLv7CHrRMxZ188iVZgDMzOzrJjTx9ahxgchBD09/cjBayvw5NPvsS99xxgcvMkU1ObOXnydR566F6ef/45Tr92mtuP3I7jSFqtdve4CllSnmJkqERf/9L/kc6l7xdpHyE8+ovDJLHiyRfW6Mg1OswQmSKxKWFIIYzGIeLKhas438NPllv3iZvfEO/6g7fdst7u3X/te93+/d7XTe8XUPpu9/9+7Ov/1b7+2ynoTvik9X3cq2VZlmVZlmVZ1t9MNqBmWZZlWZZlWZZlWdb7cIFc98ubv/l9x2+AU0QUMCJBye4EpvU2F5uxRhmBEIIoinDdNK7jYYwhl8/jeS7V9Sp9feVbe9LyW/8quqenh0xaMj83RxCkKZXSrK5WOLD/ANeuXeVP/vhZADZvLrN//wE6nQ71ep2+vjKry8u8efZNJjblcVyHV189xcWLcwgBYRh2awZdF5NE1NdbCCFIpdJIKfEcyZbJcc6fu0DcMXhBgOeEZNKSqck+Xjh25fOJqR5yZQZjPEAiESASpOigRYSXSkgJh7QS9Pfxz0cGCgjVRjo+mXQetAI0RoA0kvvu3cXlK1d48YVjFEpFvHSBrVv3Yfx+WmKAVJ/PfR/+GE+fOMZfPPkK/+gTw6jWHCmZID0DSqIi0LobahEO4Ihu5agCs1GpiBRoLdDaQ0qBcBVu4JB1BVGkiSODdNN88MMlXnj5BtdWAM8lTgwuAukqcuU0dSciwpA1EmOSbq0mcHM6l7sxkSyW3aVzK4BgutPCtNAI16flBJyPs3wpSnFlx2GaEzuYxwUZEeGxLLZxvhoyu7bKiB/giBA/XqJfv8aHd41z6coVAneA5OYC3ZjSJAUo7bOuhrlRiwgdiTExyoAQLXozFUpByLxIMAl46G648mbywQDaIIxGCHDoVnkK2Q2T3Zx8lkhNTAxpD01M4EQM5BXlVIybtPGcgCCTJ9J55lYTEjIYfMzNcyK6mS1XuqRkhLv+BvfuN8j4GsJ0cF1wZIZLtTKvLUiW4yLtQg/NOKF3yy4upl3+9MKreKLMLg+kW8VPQkDj6LdqGM3GlC5Xd69XYbrrrjtR7Z3XoBEandbEmRjHd0ikIZ3NslZtoVUbPwWHDg+TRBWWKvMM9mZxHAFGgU5AK1zXQWtQxmA03WCk7t5bjDEYrXEQOO5GzEkaIMaVyyg0O3f3858+9+8ZnzrAPR/8AU4//wbrSZ1aIukZGubUa9MsXZsnSCuU7nD3PdsYHBzkhW+cYmYm4ujtA1w6d4FzzTXqVZApOH+Nz1yq8Mv33Ds4b75touVt1ajG7X5I76pJVRjclHerFjVfLnD8yWe5ca2OlzrH3i15eLiXu+8cY+a5z5KLLnF4EnwPJsYk1csv8PFHtnLmq9CThbuOFPjxH72DyU0R60vXCdsdHrj/QVznONevN6hUKhRLWVwp0Tqm1WyTyQrGJ3q5enWZEydfY3p6msOHD9Nqt7l69Qr33HMvTzzxHKWeGaampgCIk5j6+hqlss/wUJHhocJ933jmax9+9EMff6LdUugOdJLw1pFKAQ61jfPh4xgwuMRA9J4Fvt+evnlu3/Pnytt8U+BMfl+2/1bRp2/67rv3e/Pzv1Wb+86/J9+dsPom9vX/Or/++74fy7Isy7Isy7Is63tiA2qWZVmWZVmWZVmWZf2l6Xf9ArlWY7rdDlGJwnMkSaRI4hDPS2OUpq+vTCrtU6lUGBkfw3XFu8Jp3fCPwCCNwQgo9pQIMjluLMxx5OidxHHMjRs3SKczPPzII7z44osA3HXXHVSrVbRSpNM5wqiNSmIuXwmZmIh58803EdrwsY9+kGe/8TRKaeIkIkh5tDuKSqVCu9NhamqKjJ+m2ewwPNjLqRPTXDw/w869W0FHSAPFfI7bbhs/eGF1/hO+az6HzCCNQggDsgOyhhQQh006+DzxB08W79pf/NjA4ABJ1EJKg+94RFq94/wN9A3SU+hBaU21WuX0a2dZX9fMNub56b//L+jIiD//0m/y0B0OF1IVhnoKNBfWSOcyxIkgVi7tKEWj1SHsQLmnBEYi6E4CS3SIFAbpAEYgHAfHNUgR4gqNcARuysX1M8gIOu0aO/eWWY9XieKIREmMMAQyotSTY14sA3QrA4W4FRBQEjDg6G7wKkX367cHgrQA1zVUA48zOuA5p8TrvTtZG91DI5OCdgdUiDEBHb2J68sV3rhymoGJQVzvBgkNkHPs2TnJ0PwN5pv9hO4kochgnA4IjWMSNIKqLjNfr2CMjzDd4IERmoGeNj0ZQartY1QW4YYIGW0EHhQI3Q0xIgg8iWcUwtG4joORAo3cqAKVSOmgpcCoJkW3zqZeTSkXIFrdc5DP9rIej3BlRaCdDFqAkRKEvBWCEsIjp5tsy0xz1wjI1SWMhHwAUVDi69f7mG70kmQGwUQgFTU/w5Xhzay3GuSXL9I0kt3GZUDXcVU3hKZu5vYMeBo89c6Aj3zXtdytNdW4KQgCB993wQmoLC5Rq2mKJdi9ZxPN6AZ9RYeMn8UPfKJaE6ENSiuEECQIYgNhx6Dp1p86eGAcjFKoOEEag+MmeI7AcRwcJEZoEE12TxSY3RwxMLrKuUuv8aG/9T9jFHz+P/89BjKrpEKHTUNDjI70ks2laHbaLK+scd99d7Nt2wrNepU4bOMU0kxMOBR7h2iq47vPzpqi0aZtjAlAI6Xphl5uPr5V4uld9ZTGGHzPR2DwHYfW2gp7d+xk/sYVxnrTHNg1wc/88AGmT08z/fXj/MC+QT529C5yuQwLS8sc+9wvM1zu4bf+1SGKxTy5fEAhlyasdjj10iV2bd/H6MQ449dnmbl0gZkLVzh4aA+ZbIpmq0OcxIShYWxsjE67QyaboVgs8fobbxAEAc89t8DDDwseeOAgx4+fIggCSqUePOkSqyara2sIL+Dwge3cmD/+W821pWEhcjgyQ86T5GJIJPgCEmFIqALdf1iONwKbyTefJcuyLMuyLMuyLMuyrFtsQM2yLMuyLMuyLMuyrL+cm2GOjVCSMBC2OBZ1wo2ASze4FCcxbuzhOg75fA7f81mtrJIkMa7rI4TAGPXNuxfi1n7KPT10Wm3WVldZXFoiiiKmpqZYW13lzjvuBGBtdY1CIcdadRUdKfL5PIlKyOdhaHCIiU0T9Pf2USgXSaW6IbnRsSFc4aC1olqtMju7xuDAALlsDq0Tms025T6fU6cu0t/fS7Hfx/EC8vkSu3Zv5tLzL/y6NPXPeVJgjMYIAaZbiWoM+J5PxksTBHx4sK/f8aRLK47RMqFarRKkPOTbBhAZY9DG4LkemzZvwUmX+P0nXkSWe6jHLUY3bcZRMeMDTTY/kGbh6kUyrk91LcQJ8iQiT72dsF7v0GjGvHlxvfv5iG7kJp2BQiFNqZTF8cDTDq5OcHGJTYR0FI6UOI7ADRx8oZHGIZ2BRr3OcKEHoyM6cR2Ex80ZM0abb4r0aNENqgndnabm6e73DBJhJEpC5Ke4qGKOewFv9vYTje9nVmdQrRb4DigwiYMiR9uM8srVLDvHtrAtm6Bbc0RqnbS3xNGpMrOvv0lFDxDLAgpAJCAkBo+QPuq6QkwOs1FK6EpNT1Cnx4/xwhi02Xh/3bUtjEYrDd0WTyQGR4AQBkcYpOgegxHyreCd6+B06hTFHKO5BoUARAMkCjfVQ0ONsBIbEpnu7luL7pg77eAoRdbpkA0vc8eOdQbNEiqpIZyNAJk3wfPnAjqFoxidQ3o+WkHcalHBwdmyh9eJcJYjsnFEVmh8EeLc/IyQCDSItyYN6bf99+26NZwa19M4QTfQKIUgm82wWm2gBPhBTKmQxXc6CAxRGNOKDBgXjY9G0IyhFSlanYgoUlTmko2pbYCBjA/FfJpCMYcrNenAQ5IAGi07sDbLYw9tAq+Xl15+ndJQD9WGQAcDXJlf4qMPHGTnpjFWl5cQjo9SHRzPZ7W6ysjoAGGriOdIRNSk0axjHI/e3vLhQmHl49Vq9aLW5rab95juPacbNHz79959P5LyZqmlxHU9HNFdNJ7nEIYh/aOj7Ny+hWOvTPPRH8rj6wYHduVJeb0kSYJOFJ3OKrkhzY7xYYJ8ilbYQMkGWsT4nsNLz58lUQHbduxkcWmWICXYsQOuX0vYujUm5SuSSBEEAWHYfW+O61CpVLjjjjsYHR1heXmFe+/1ieOEwcFBenuLvPjiNA89dJj+3j5SSFzfpR2GjA+WOLRr09Abr778H3btvesX0rk8+UyJm8ME5cYExJv3KrFxP/nuZ6dZlmVZlmVZlmVZlvU3jQ2oWZZlWZZlWZZlWZb1/SFuVh3Cxz52x7Wzr7589vCu4V1BPnOr+s4Yg5ACrTSTmzdz9cYcK5UlJjZPIrQhjmOEEEjTDTMJujWUcZyg4oj+vjInT5zClYLZa1eZmtrG+uoamUyGsN0mnU6TDlLoRG1srxFa0Wg0mJgosmfvHpIkYXFxDkdCKpWmVquTCTIYAwN9/Zw8foKZ8zAxNkd/bx++6xJ6sGlijAvnLh374l+8MvzBH9w/NjDcx+JqhUIxz5aR8ZEzb177sd6+4PPg4wfpbnDLOCipcfCI45hSKXgwk8kQhiGOlBhj8DwPk2hShQyO79HpdPBdD4duqE8EOWbWKsTFIo99YBOvHvstvvonEeOjkkBpGvUQ7cJKLSKKfRYqFWbneH65yjOLy7y0UuWK9Ln6yAd21778lelcGPKxYol74qRdLPe2k0zA9tv2eEdHh4uU+0q0Gmuk05IwbBMEbfp7e8gUXJaXm3Q6oHLdIJPrGtpJAy2z9Pf3YmYN3flYIBEY0Q3MaAkNpztVzdESR3eDSUYbhCNQ2Ry1UppTlXleToW0xvuoKpeUl6WlW0il0G4KoyVBrAlNgdOtPbywsMK2XW285hxxDF48ywcOjHBlucXzs/tpMYISCYgEYwTGpMAdplK7ysxsg21b+4kaNXxHMZAL2b+1l7/42hV6ho9S67S6E/2M3lhDBnR3gporHaRMcCRIpzs+SiNJbk5AExIhDL5oko0ucGjcUPAMbd2tOvX8Ihev5Zlt+yRBGlDdbJiQCC0JdItseIEdxVke3uMgly7gOWDcgJYzxLOvJSzHW1lhCO0aRKJJKUkkU2hHsqIMgzsP8fqpBvL8RTKlgEyQQzQaaK1xpQZHAgnxO5JF3WvO2QjuKa1BCVrtJsYJ6SmnMCZCxTFC+BvXPCA7pAMHVwuUEnRil4iAXGGAZqi5eGWBC1eqzFZ4pRNzPuzgtmpUV5Z4bmiQP777jq3Nr3x9phC47UkvaG8KPO6cnBAPlErpe0bH+hkeHATRYH22TmmwwI6pHL/5W/+AnuEDbN93OyeenqfaDNE6wWhBvRaBTOMGHkm7Ta22ijQucVtB0iaKInAdCoUCxdLKgTAMW28PojUaTfx0CkdKwjBkYWGeXD5PX18fKT9Ho1lDJRrfl/T397OyvNytR1XdtWJE97G+usTOfbuYXbzESydfYd++3fSVe9GOIDaaIPDJplyEcNAmhUbRUuuks1k6xrC0VuFyZZmH7n+QxFWkig6joo/5hUvk44TnvzHN448/xtBwmfm5WXwfFhcWOXToEF/+8tOcOXOGHTt2Mj6eYWpqC3GcEEcRhw4dYnHxab74xZM88MAOJsaGaDYiAtfHVTFH9mwjaeif//M/eOrJn/v5T/zhSm2djoAY6AiI5MZkRAHORlXsN8eKLcuyLMuyLMuyLMuy3skG1CzLsizLsizLsizL+r7TWpMonqrWa7t6C1k0GiG6aRijDe1Oh0wmYGSkl5XlFQZHhgmCAK0VUspbgba3gm3dUFQ2kyGXS3Ps+DEc1yGfz9+aaCSEIEkSPM9Bm2Rj227wpNVqIaUkCAKUUvT0lKnValQqFQCSROG6mpXlFTodxdEjATduLDM11SCfz9KJIVfIUiqSVFb47aVK9X/KFPMIF0CzaXiAc9OX/zupzOeFdHG0xAgX8DHcDO4pgJ3d4zG4rouUEkdINAkLCwsoDNlMhnS5l1hrCvkCZy9eYbYZ88/+1a/ypT//JJ5oUl8/z45772bu6gzZjEdkfF46XZ+5NBP907UV3qw2UK5H4GcYyGbZVu7n9pMnpsP+flaXV3gWwR899gOTTccVqE6Tz35uqX/T6PI/37adX963f8DNZXOk022kG9GKWniiTZSEGLgVrJOOAB2RzuRvVR5qY25NU7o5IUuLbqWn2pjYpSSERhNLReQJmn6LZy+fIt4zxo/9yKP8zsnriHAUSCGdBGUk6O7kLi0jIp0iDg5y4upJPjJUYELnwDRwkyqlaJpDYxO8vrLEihoDEgyghUQYF+nl6CQFluouLZPDkx1c00GHKwzk+ikVQxb0Sjd4ZSQYkEZ2Uzh0JwFKcXOCmuTmEC0lJEpI5NtmSbmiTa9bYSClEUkNzwEXQZi4XF9Ns64HaRsPtMJR3SpbjSBQdfo5z23j6+TFEkEKwg4kqV7W3L28eKlOxxkCnQPVwYgEpQ0SF21cjEhY61xi5/4UPbkcFy7NUArGyIeQjgxpJCndraHV8q25ad1pau+chXWz4hOhMU6M1gnamO70NeieJxGRyRRZXVij0QhJZQdpdjwWVuq8cfZGcuYC//7aHP/bz/03u5fXqnV8L8UX/vRCNleiT8P9J07P9OR7CeKI9XZErd7hs69/xfyO57TkxKaru3Zv51/fddvIVE8xQ622zuaJLC++cYbB3RPEyST/8jc+zaf+xScYKkrG+idoNSOE77G2vsTK4g3y6RRDfeMb12H3aJVSeJ6H5zLQbRdV3eMycuP+pTDGECcxcRxTKOXRWhOG3amQSaLwfYnWGqU1iUpwtECSkKgE6UjiRKG0YdfePRw7eYbTZ9/k8IGDSClZWlrC8zzQBil8jA5odzo0klX0Eqx32ly/Xmd0bILNW6fo1Oe7tcJuhB9IRkdGWFtrcPbsOfbv38PI6DiO8wqe75PL5nAciKII3/dYX1/H84pvTbMUgvvvO8qf/tkrnD59jkZtnanNm/CDLB6CIJAc2jXB8sryH/zH//i5Ax/44QdOKyDBITEpYuOi0ECENiEYB20japZlWZZlWZZlWZZlvQ8bULMsy7Isy7Isy7Is6y/t3UV4SaJJYr5eWVr5B9s2jWOSm+GQbtil1aoTBAGbJjfx0ksnGR5bpb+/H9AYB4T3zqLIbp1eQjaXI5fLcerVBR59ZC/pdJp6vY7rugghiOOYdDogihPeXllYq63j+z7pdEAYtvE8l8uXL7G0ZNi9u498Ps/S0hJf/fIJ9h8YZXLTJF/92vMsLlQoFHKk/ADXcSn1Fu+6eL+LlGsAACAASURBVKP6p2fPXv1q70Dvo+Webjirr5xjasvIkZdeubzt7nvvvlBvxGghkSi0eOvsSEMvgDEKR3ZDRa6UCDdgaXmRuYVF4jhhuZKQzXC+p5wdnG+bYiUYphrCwOBeVm68xH/99+5kvXIaP2nTrgd85Zn63PMv8d/n03BgL7/aP8Bj+RyZUkmSzWWIEoXRglqtRTafZ26uzuK1K5djxbGZc3zZNfynn/zxu35lZa35K5/99On/cPd97Z/ftrOfXEljojViHRErcCWkfA+lE0Dh+4L0/8vemwdJct13fp/3XmbWffZ9zNFz9NwYAIOLAAGCB3hLJEVKa64srcKybO0Rko+1N2IdsREO/2GvJW/4D4Ui5LV3Ja8sUaQo0XTwEAkQB0GAuGcGgzm7Z7p7+j6q666szHzv+Y/qmcEMQAzIBhfSbn4iajrqyPf75qtXr2Oyvv39pRM3zbWU4qZIJWlB6S1Dk4VQQVNY5HCZq90mLy6/QnO4w6c+dwAn9yKfPZTiT86dYlMZtFeCSEFkkFgCNyI0DiIYZ2VzkQvTZ9h3cDeRmUPqLrK9yvEdE4wtrzGzNgOyDKQxVoGVuCKNjpLMViw1m2PQqSO7VYSFsVKCwYGIudoiVvZjbbqXoGYlSNVL9pMSVyqkBoTFUQqkQEswW6lSvffXkHAi+pN1RvOKqFsj6XoYJFXfMruhaIoBIusiMCR0hAC0laRMnYOlyzxyxIBt09ky+Yn8GC/NjnG+HkAhSZo2bQmRkETyWktSSNlVJuxTPHxI8MFPDvD13/8eTyxUOFE6zj4ShKubZJEoo2HLOAjyrR/irfNAGFAgZPim93SrRagAiWF1YYVuB4zIEeos5y8t8d3vtv/od//rL/z22Phl/vIbp5xnf3D2P3MVnxga4N5HH2Cir09SKhfwPEmrtUEY9ox4OoRWk/bSVb43N8MfP/MM/9TIxT985NG9I8mwgecY/vnvPMzjT01hkgdo1wWBsTz77CmGileq1c3maiMwk8WSRz5lUaXSDQOl6N165i0Pz8Pzfeo3zFs9x2EQdNE6IghCgiCkUMihTUgQtJBKXm/Ba43BWos1tvcYBms1VgqEEGxWKxSKA+zcNcqp1xepNl4hk87Q6XRwXAdrLQqF0dBo+AyMFDAY/DDk4O4JDkwex7OGRruNkgGOa0mmHJRNcufxw3z7O48zNNTPjh1jjI4OUq/X6fg+Y2ODVDY3sFajTdRrI/smhBBMTuZIpzOsrVaorvtMTkwwNpglk5LsGMzxsQ8dJ9U39ez0ldfvBS5gPCANeFtJgRHg99YOG29dPDExMTExMTExMTExMTExMTFvIjaoxcTExMTExMTExMTExMTEvGdcS82y2qANT9XrdS2lVG82MFlrCYKQSGv6+vrIZFzW1tbI5/MoR6KsxTre9fS0a0jVSzdKpzMAeJ5HvV7vtS10blziiKIIa8zWMQCGdrtFMpnESySQCJrNFgsLC3Q6sHPXLl5+6SXmF9bZu7fIwQMHSaVTjAwXWd9YZ3ewsze+UGRyBQql2mcWl/jm1bmljw2WS/h+i2K+RNLTFIt8PtCd3zNSY7ZaPgrj4EUSR4QouvNSBEeksDiil56mDARhl527xhkeG6JabzP9nTNvPPaZx47+7n/7/U//5n+1+1t33n0f//f/8T9hGg3uv7MfHczhiiYRsLHpMzWFfPRR/uDBB3aPpVOGTNJgTJ1IN7G6SRhCJp2A0QxBqBkZKOA4yYmNzcbEAyfsr1yd7fxf3/3u899cWuJf/cavfei3/82/ffqP243m43ffP5pJZxNYGyAMuAoSrsJ1ZS9NyxisslgZYaRhK+gOKyCUkrbj4CuPQPZukfCoAYsmYHGjhilb+j90hPvuCigUV2jWl/jw/vs4OXeKbrPLVXUCn7Fe2hcWowxIDzoZVOEQT57/PndPTpBLVpFmnqDWZXyiyl071piuwXx4F1oXQfWMVoII4aRZaCapkWMwsYGMwGoYTMNYusWZ1QWMmyUS6Wsr7/o5SXvjka2unFgbITGIa2YuAC1IiYhyYp3+lIfqtBGuJCET+EZRp0BLFjHS2WpFq5Dax6VK3s7yoSOWXdkllmbmyCRAJaHip3j85SZu/0dph3nenHZmrQHlkzBNhqLzPHawwQMTHeqNRT71G8d47fs1zsyuc7ZSpi8zzK50kqTxEQS4JiIdRSR175ZAgQbHSPTW+QoJSIG1BiUEERpX9eZDGIdEOk0+k2V+ucurr023XnyFj/76r5944X///b/+0Ng4/80Dd/GLu3dDXylHX38BITXdbgtEiONqgjxYC56TxFEF2k2bTj6Q//zC4sbnT53eXLhwGdE/Ns3EjjRD5QSwSb+3wVe//29Znn6ZRx65m5Xp1/nan1f+/q//2j3fee75l88c373zyEi/S+R3eu+RlJgt42QYdfCcNEnBxXaAf63lLCiwFm0iwjAkCjVRZEmlExgT0A0Cksl0z4RmHYSU181pQgiMjnrrw0JkLe1Oh0KhyMDgONn0IiPDOyiVygwOjfVa++peS+NXXnqZhJfivhP39ZIkrSWVyhBFgrDTwmqIjCXhSTw3ycVzl7n7rgf4wAeO8q1vvcInPmHYs/sgTz/zDKtry4yNDzM11aSyuUmr2SSfK15PoRRCkkqnaLXaFAoFPve5L/DsUy8yc2WejSUDtsPgzmFEKsfRYwdzq42L5yUcF8I/7SDBBpgtQ6MkACAJWwl1Px3Xj9gyYb7ZJCnfxjB549N4o5bhxnE3pwG+3XFvqfzuNL5lvGsb3S0Pv2l/eBejxvX/DtT/6V/97ri9xrfn56HlZyHW//4S639/ifW/v8T6319i/e8vsf73l1j/+0us//3lvdQfG9RiYmJiYmJiYmJiYmJiYmK2zdTUFEkqGOshMUjdoq+c2Fhe6b4wNXX5wV1ju64bzozpmTnUVsvNHTt2cPr1y4yPjjC2Y5yV1VU8x8V1b1y2EKZn6EIbqpUKIyMwODhIGIUooVBKIYRCyl77PhNppIWE47K2sorVlkMHJ6lu9JJ+zp89y8x0l5EheOPUacIo4sSJowwPD9PudMjkCiTSGVaWVwhDTUIpQOIlExRK3sPVRvDNmbmliwf37Jp0XEvQrZHJOXhp9WizU/89m1RgPWSUxrWwuzRMY3MWv8Fqt72MKJYQNoGyEonA2IhKa4NUIcPKxiZd4Tz+8qU6zhAXGlGd3cV1vvxIiddeWubYjjLJKKIbgqNgcwMePMHwJz55J5XmDAgfDeTyHkKm6HQ6JE0v0QlrSXkSow1a+5RLHpGBPXvLrK+2fnHqYvUXn3ji6TNC84+/+TW7b3Nt4S9+4Zf2PJJIGzY3W3gKPKeXnhTZiF4wkyGgg9BN8jKJl87Q9Zv4jqKSKrCSLfNiJ2JF5WjaDLo0zFXt4LubDJdn+UdfmmAsegqz8QpZJ0JUX+dfPHaI3/v6MzzZHGcxuZOu3Uook0BkQWrWQ4+53EN8c/Y8/+QTB6lNzVNMgt86x2cPDfLy6Wn8xAnm60mEbKPwsUoSCMlcPctURbFnPIMLCB8UPseympOdFZbUDrpO/nrLxxsYBIZcNkkDgxEGrCZhBCkkoRKAoJguEyyuc9e9HuX0ImHYwUQWkUxyZabCfMcSujlAoKRAyxTStii4q0wk5zk82CITzbNnZ5ZavU0yPcKPTm+ytDJJMDhOixQBDhHtLWOQIuO2KdVe4P6hSzy6p4tTOYUTRYSmzid+9R6eP1fgj380TFPvpVuZo6zrDOkm436dh4cGGWpW6G9tItsdhko7COptTBAiQttLShMpoAOAwuJtGdSW5uv0Te5jZaXDk48vPfPMj/h75QEmX37hldO//EvJY6NDWQaGMpioQ2gCdFhBSk066QAGYzRhBKViDoFLrVpFCYu2dfqHu/zGfUfGvvr1N6itQfFYGd+vsDl7mQO7C3zo4BJ3Hu8wONTHmdcqRGkuTK81CRSPh6Z9pNWNSDuSIGzhqTRKSZQyDA1neePcDNVlLiQcGquLS5QL+7BCUavXSaYNyUySy1cWSWfT9PeXgYBk2gHaZNNJ2i0fjEECvu+Ty2XoBhFKWIwxSGvIZbK0Wh2WZldJujkO7j9AKpXB6gQYiRQKRETWS7NWb+Ah6dQaSNfBsYpQC4zROMojMhFWC/oGRkjP+5y7eJZ77z2BlZbvfe81jh7dSyqTZnVtjWPHD9E41ebK7AyHDx/tpbzZG26eTDLNnXfcwYsvvMa+iVU+9MkPsTF3lemp8yyvV1i8cIVKi2ZXeH+yMB+cv/++gU1NEoODvdb+Vtxomfqhe/u5Ydv82bDi5mPFWz57N5Dv8NztMOInabz58XeqcS0U077JQ/3Wcd9J4+31/ySDHpj3oP7bj3tz/Xc6/xum3Rv1f7Y6P1t93qb+ezv/N/Pefy30k9/fd+bGPL+/X3HF+mP92yHWH+vfDrH+WP92iPXH+rdDrD/Wvx1i/Tf0xwa1mJiYmJiYmJiYmJiYmJiY94Q3J+AIIbBGEAY83fGDB424cTnCWouQAmst3W6XdrvN7AxcnbjK4MgQuVyOMAiRUqK2UtOMNUhxywWZrS+klVIo6V5TAUAYhkgFQljqjSpRBM1Gg6tzC8zNzaIQ/MIv3M2582dptXwee+wj5PN5wjCkXm/S6bTxfR/fj3oGr1QBawyhCegbGMAPF/ZWN3liaWl1cmLPMFYGFIoZcoX8UCQlUvS0GBnhRNBeW+Pxb/3N3YcO8MujwwUwEahE7yKPAIveSngyVBttpueiZ8YOeIztZWZ+pbKysXBxiHCRT39shFZ7DS+VJ6qA34HRUaicAb9Vp1jIEekIz7XU6nWiEDLpdK/lqe1pUkqR8DySUmGtQWvDysoCUsKhIxkO7s8eXb4aPX3u7Mafv/gCf9BsXJa//PeLH8ylM1Q3WiT2eBjTBml6LTulQycl2PRaNLUCo1kJYDVyuRoI5vyI5YFh/PI4NjVAQ+aoJNJYWWGxE/BHT5zktw932e0mUW6byF+FtQq/84WPsvHtS2g/xzrjtMhjZc8EI5WhZTwW3EnONGtMra8ymOqtANc26euc4rNH97F46iquHECbkEgKlPAJpaSldrFYaxCOpfAEveCssM6OVIMhx7Jug+trzGLeYr64dleK3jpWxqCE6SWOCYMIGgxmLAPZEBmuIYVFqwyhzLFSt7SiBDgp0LaXxiUk2WSX/vBVHj3cZSDTotuoApDOjTPT2sHjZxtEub3oZJnADwkVWCTYCKG6ZLvTHEmd5tcezuHVzhHU27gJKA7tZ7qb4P9b6HBmeJJ1dYDCvr2styqsVlaYX19ibmOFHYHHTlFmNBUyErYpZQVuOoufSKMdEFJjrEYhkI6DsAEJCUMD+2h1PL7ylaln5+b4g/vv4V8dPiK/PDicZ2QojRQ+7eYSUoJ0HTwpEMJF2d5lSR0FeNJB+x6uK8mmU6TSLn7YIZ3Lsrw4TbMCR486tKsrCB0yNFqEsMYnPthHrXKZ82/MUmuxHAhmG9owt8Qzx9rN3909PkDYahLqDo50cISDchwQhtHhfu44oP/h62ea02EYWKO1UI6D53lo20KpJGvrKwwPj2696VFvz7GSTicCFGEQMj/vs2t3nYGBPoTopa8J1HVDmARMCAkngasUOgxxRKaXrigDsL31JKxEWomwW0mU9C4CG8BzE9ggQusuqVSGRCJBGHZpd5rcc+IeBvomeOPMGzQabc5fbLNj5wjaQBhoEl6KKPC50cZUEOmITDqD48Ly8iL5TJZEJsHh48c4lriDKwsX+f5T0/Lue+/+J0fvLPHkk8+BiFC3fgCuJ1mZm/bkn4mf4oK3vOXivDDvfLHeyjfpsu9kUtsa/xYtwr7989dGseLauO847JsF3Vrxneu/xbxltlf/Ntz+/G/OsbNbiXo/uf4t8/23fP7fyk+n/3bc7vxu5c1GPCy9BMObR7xNxVj/TdVi/beOeJuKsf6bqsX6bx3xNhVj/TdVi/XfOuJtKsb6b6oW6791xNtUjPXfVC3Wf+uIt6kY67+p2nusPzaoxcTExMTExMTExMTExMTEvOco6WIiQ6fDy81mEwAhLQgNQqIkhFFIt92lVquxdy/UajUqaxuMjI6w6W9ijLluUPtpiXRIIukSac3a2hrtNpw7dw5rLaOjw0zuO3A9vW1udpZ6vU4QBLhOgnQqhVIeSjo4EpRyMThoq2m12vT3DRJ2W/eeO1v9xsrqOkfumKQZbFBvNqg2O2fyKQ+Eh8CgZBdXBShRp5jjW3cePZTMJC2R3wIre1+oC0MYGJTjEWrJ6mqNXI6XtTEc2X9QX7h0/g8bvvwf+8t9TM8vMTgE2mpSOWgHUCwVcJ0aT//gMp/+3J1EUcRGfQnfh4STwRWjtPzee4CI0MJiQoPjhEhlAcPwYAatDTqU+LrBoWNlDh2Z/PLOHZe/+NyPo6e+841q5bGP7yz3FVq06g2SqWsRNg6B9DjfbdDwNF4moJUp8KOVceqlO+n276CbyRMITWglJkrQMYJ6twHSUkqfYKYu+f7ZVX7lvn3k1Awtv4PvRXjiCr/xqIt6+il+3Pw4XcpYIrQ1CKnpWAlyiMvVEi+c7fCFOyYx3XlU1CbTXeGDEwd44sI0q36OdTkEsoCxFkgQODtYWLmC3F1ARQmE6tKOWoz1t+nLapSvQSRA+VirEaKX+iekQCGIMFtGy2sGsxvmCIWPDNcY64sYKqeJuppIA26aqu3jyrrFDwDPgjUIBFIbZGuaA6XX+MiBEo5uoq1HUkf40Tg/uDrJj9uSsG8n3USAjlogJMJKXHyyZpndzhv8w0dddoqXqOkKTgqy0qPZGeKv3tjBs5VhVvKD4EHFD6i5ZezgOLbf0vZbTHdq6HaDXHuG8tozHEn5FLuGamWafYcBpwMiAGuIIoMjPcIwYGWlww9+MFVZW6H92Mf400cfLXpR2EuXM9SRnkM2kwdjMaEgCixhJNDSAesghcKRLn67RSNq4Lgaz0uS8fqorLR58ns+gyXYNeIQBD6eB27KgtGsL26QygzRrMHiIn/4kY8d0lFkEYKXF5fqTO4YRfsu0o3QIsD1XByVIOi2SKcyHDt2ZO/i8gt7Ox3fRpHFSzokk0lCG1GrNeh0NAMDpa1d5cZepI2m0/bRJiSfh7W1NXbt3oHjKEwY4Tg9U5Git1663YCE65HyEjSbbdyUwNpeW9FbfbdS3kiaBIGULtZGOE6CoNshnUoRhRGO42BMRDfoMHF4kl27xjhz7sfsqy1jrcVzJZVKlXbLx5G8yVQGOtKk0ikcpVhYXGDvxF6stWgd0Ql8BgcH2blrMf300z/+Bw988ON/8jNtwjExMTExMTExMTExMTExMTFvIjaoxcTExMTExMTExMTExMTEvKeIrUQgLEQhF33/RnqP0b22cL2ENUMYhnQ6HR577CHOnTvHlStXKBQKJBIJIh0hhMBxFFLIXuqa6bXPu4aS6qb70Etb0zpCSZcgDKnXGxy7Y4w9eyYwGhKJBO1Gm1QyydraGpvVgFwuRxRFvXZ6rntDL6CtIDKSyGiqlXV27NjByNDAiakL1a+1Wp3FRjMY1V6SqZklpuf4vbuGtpKTLCgbofB5/DtP/J+PPrRruJB0ESJACwekBCUxBozWOF6CMFLUa2bqjmN3zDnKpVQe4eTJ8//Lk89c+d1Pf3pnOZVP0eh0CAgZGMjSCdsYLXj4w0d5+cUzfO2rJ9m1G0r9EIVweanF4sIlimVuGFQEFPKQz0Oh6PRaHg6W8RyFm3IJ0wGr6/NIJPc8sM8bGNz8+Le/sxb8v381x64JyO3PAdWtc5SEyuCMCzJDHsM7BxBDO1hbGuVkI8HlpqHler3EGusgZc+NM9A/wNriMm1RYFMd4PmrM4wMNHn0YIDKVDHK0qzOMeqFfPrwHmaeO0NIlpYt0rQJtAKEoqtdmmKYF6eSPHJ0kj7RIOl0sH5IMbHGw3uHmTt5lhp5QlvG2JCABEoOsVJbIIgcrAbhSXTUZKBQo5QUOL6/1cZOgLHYrT8BVUikVFuGNYuUvTQmI8x1k5qHjxteYTDXoJx1sTXQGkQ2SzUYZbFZB9FLT0MIlIkoqpB0Z4YP3delz5yl0d6glC+SCDxm2iW+e0ri7P40G+0EWrexboSIQhwERb1If/M5fv1TCU6M1ticmkdaKA710ezs4vm5Pr76IvgT90AYgQ0hUUCHlgVfsNgFa7IkHUu+1GakGHLnPXvYmW2j1mp0ply6iRBjA7QOcCSEfkgikaPdDnjx5QWcBNm/96vux8eHQmrVKqkkKMdBOiWkTNINQhrVGuurHZo1aDbBdXp7hNGwugJSwdAITEykaDYqzM8HXJ2DiV2wcwJc2SVThEzKA9+n7RuU5+HrFKfPzGw06/xLYxTdboe7TgzNiXZtStjMvmIhTae9ibYBOkojhEO7HWCNplwe5sCBMdpBRWgdISV4CYUrMly+fJlUSpBKeVj0jYQva0kkEqyuVHCUw/E7D3Dp0gXQBke5aB0ipcWaG39WHIYhmUwaKSVhGJHaSvszRnOrB1cIibHX9jmJNQZrBVIopJRo09s/wzBECEGzWafTnsXzPEqlAvsnx2k06qRSGRauNlhdqTAyXII3tfgMoxDHKrLZDEo5RGGEtRZjNUKKnnl3dIzTZ6YeVI569wa1660/f45so73nTWP8vHW+U+1ts712qtuvvU3+rs//+6n/7/r8x/pj/dsi1h/r3w6x/lj/doj1x/q3Q6w/1r8d/sPTHxvUYmJiYmJiYmJiYmJiYmJits/bXOwQQmAtS/V6p22MSV9rhxhpjev2WnIuLM6TTnrs3D/J4vwC5y/OcOhQSNJLII3EanomHgnWGoyJ0GGXfDaNKxUG6AQBGIPYiiISxtJX7iPUHV577TWCAPZNTIAFKSQ6CEmlkxirsdZSKnpY0zPKRCZEG0PQjajX6zTbkCmU0ZHl1VdOMthfZHLXKCdPncRv49Qb4XMbjehL569cYWqWf3b3BwbfkG4HYTQJ5SL8iBefvfqhX/hI4Tcnxgp4LlRqTRLpFMLziIQligxCuXR9y+JqlVymdDKdzhIKQa3a4b77DwdPPnH2E8qde+kznx7CCh/dtSyuNvESOfy2puHPM3lkgMFqh421Jpdeh9VVEE7PrJZIgnLA9UAI6Lbh8hQYE5HOwBm9zu4JOLB/gmTOZch1kVJSq8xQ6EvzhS/u9n70wxl8H1KpFKHd3GpjChu1OVTJcvfhNElRoxP8mC8eHGL0Sha3fYALjQO0k5P4KkeoQgAqG11QBSIENTFEqvir/NXJ7zM6EvHQpGR5+hxpASpY55GDR1iob/KN15/jkn4IvN2QUj3DUEcQ6DLnGwd45lKD//SOnXi1JZoSOq2rfOr4AV65cJYF/yjrxgMp6AoNqsBy07DRbnB8d5lGa42+YgLCZfbvGOLxjU0cpRFCYa3EbJmElFK4rkOoemYmKUEp0GhCDNYIHDoko0sc3eXQl1VEDUiXMlRVgYtLGWarEpJZpLVgJAkT4DVmOdrX4aHJFEVnFZuIqAUe6aHjvPSMoRKNsLzpYR2BMQHS8dBhm5zbor9xiv/y7g0+2leltvI69S6M9YMq7Odr0+P86Ss5zNiDdHQWbACBAQ1gcVQblXSQokwpXOQO7wk+unedwwMRJbeLuwMOHN7J7Mw0naBLIdMz7CnHwYkU9XqvfcOXvjzopZJNwlrIwEDPbKZUmma7yNlzCzSabaIQOi1wJBRL3DBMWujTEHbh6hU4/WqHnbthYAjuvBP27ivSrFdJJZNIx1CpdanWoJDrJ10e5f/5d6eZvsIn9+zbGTTrXaRyQReoVesnFxaq+/aM53GkQBiNET2jVyqRJ4witIkIwzbG2F66ngwQ1tJsBsxcWaJQTFIoFAm6rZ7UrT0m6AQ0qg2UcrnrrrtYW17i6twC+/ZO0Gg0yOfzGBv1UiOBMAhwCwUAcrlcbyxrsdbSarXI5/NsrK+zvr5BoZjDGo0xGqlchBDoKMLanjEtCvXW3mpxHAflCDxXonWHVNqlWtvsrUOVZLPSYHZ2kR3jw/jdBr7vk05n0FFvjF27dvPDZ09zcLJJsVhECJemX6Pb1jiOi6s4FnT8d/EL4NpFZ/P2BqDtXgy/dcyf1mR06+vFT9C5Xd51m9Jt6se8/Rg/qf62v4z4CS1lrtW7bWvNt9H/d2n+/33pf9fE+mP92yHWH+vfDrH+WP92iPXH+rdDrD/Wvx1i/X+b9McGtZiYmJiYmJiYmJiYmJiYmG1z69ff1lqkUBhBA6hba9NCCLQxGK1JZjIYa3njjVnuvnsS3Wxw8OAB5uYXmJ6e5vDBQ0ilemNvJaRZa4giTRRput2AIAxxlPsWLb0kIMtmZZPV1Q5Hj+56y2uUUrRaTYIgIJ8vApBMJUkkEgTdiPPnzzE91eHIHcP4fsBzP36RRCLBgyfuIula9k+Mc3ZsPuVrVl569QznLlf++b0fPPS/LtVX8VyQoaJTa1F2JeNDfGX/xACu0yEMNW7CQXkJcBSR6RmbPM8lk8hxdcln6tLma3cNS6wRIB0waX7zNz/x8lf/4m8e+45a+cbDj+QyuZymG/h0TNBLJrMS5TqU+gYoFHbywtJZ9u3LcuhYH26qQxQ1QRiE9BDCxQQCz0vTanXYrGyyvBhx4QJcuniFnTvhjrtyIAzZnKLdbNI/OMjoOHS74DiSMNpqaWnBCoNJQ9M2cUwH0wgZSSzzCwcP0l+q8ZevvMrlSFMRu2irHMZmkMbDQRIZn5Ac875Hduhj/PEPTpNM9nMwv5d0tESnvkFQeYOPHztM1e9SvXQV3/YRmCJYB4WhS57NxAmenX6FR3enGJdJpNMlaVtk1SU+ctcIJ19YpmJ3YKTECEHkJvFNmoVaSAcPowTKNkmJiImhYRKqhaCLtA7GSrASKwVKSRzl4AiJlBIlFSiJlj2j+pWrVgAAIABJREFUlkGi8CknKwxlXAhruEpgTIivEsw3MnTcQYxNomxv/jzbZNC5wEePC/qyLRobXdohiGKRs5uDPDfXpSFHCMlCZJAY0ok0yi6Qq7/Ih/ev88njlmzzAhudJm4SWmqU05eTfP10ioXM/dRUP5jeOpHWEAmDIMA1EUlbJW/nGOJlPn14kyOlq6hgg3a9gR8JpHBod8Aaheu42KiN5zkYLPkClFOQSnVYXWuzazhBulCiWatw5kyd2dk63Q4Mj8LwqMPIcB+uqwijDogIiMB6CJsjk+pjaXGDM2fmabZgx3iZPXuHqdaXCIxDJ5REXag0BOncCHNrmpdePt2anudze/cOv5xM5GlbSSpRQHYFi4sXX/vA8eyXut0uSc9ueWgkxijAwWB6a1caXJnYSmMMCcOIleU1qpvQ358gCH2s7SU/WmRv3SmHWq1GvlTETWdwXJf5+XmOHzty054lheilxFnbS4C0Nzto9JvSHzt+G7/boijyvXabxiBVz+grhSDUEcBN42ijMSbqzaWIMKaXhJZOZcFKDh4Yo1Fvs7q6TibjkEgkru+l0DPLZTNQqVbp7+snCHtmNM/zKJf6sIb9jz/+ZCKVLXTf+TdATExMTExMTExMTExMTExMzDvzflrlYmJiYmJiYmJiYmJiYmJi/sNHG7DWWIS0bAUK4fttrsxdxvNgz54JatUGqVSW8ZFR1lZWaTYa11OCtDEYozHXf2rqdWi3WmhtuJbMBlspa9bi+wEzM3N4HkxMTCCE6N1k7+Y6CWrVBp22T19/P8lkBtdJIFBcOH+JxcUVTpzYydL8Ms/96DmcZIYHHnwI13No1KpYHYHgeBDxzanZyn8yeXD4f16rVHDcNAkvR6veZWxghNlL0//FAyfKw+WcJeisE0U+2UwGR7lYqQhshBEROBajDa22plLnlWuXbAwOBo8ocPnylz/2+PICR77+9cY3Ll70qdVTtHwIjUOj7dJsuFy6tMx3v3uW8hDc+9AQ7XAWZB2EIZlMUirnGBotkSlYin0wNKYY3eVx+C7JiftgdAcsr8JX/qzBxbNdsCWGRocpD4Y4GXpGLKURykGInuUntCmWazC/VgBRxLHQ2TBEC2e5S/2Qf/rhCg/0PcuQfoFMWMONPFwtcYwkGXi4BlL5iKnNNtPe5/izl8Zpi10kvATCBewiafM8X/yw5fjIZca8WVLdABGmkEQEymNN7OeNzTF+fFUQ5HYiXUUuEaD0FY5MhOwZWCbtTINbBTcAL0FAigtrEesmS6QUNgrISJ89wxnymQgd1bCRRQnvuhlNSoWQEqkUjhTggHAEWvbmBkDZgP5sm/G+EIIGCkGkQ/xIMLOuCJxRjPVQ1iAsJFllX98p7ju8Smhr+AKSLqRyu3liapjnVvbRVOVeSpFNo6IsiaZgqLvBI4VTfOl4BWXmaYQ+xVSSXH4nbzQO8q+fsiwn76FmhntGRxkhjYcwHgACg6clg8EcH0h+hf/+EzPsG1hA6zWCoEo6KxkoD1PKjVKvgCRLJpnrve8iAqeLm4BiEZIJxf79JUp9u7g01eCrfxVw9gKUB+Bjnyhx6KDHyJjCTTRJpAL6B7IMDPcxMDzEwEgJL9Oira+QH2jx8Ed3sHcSXjlZ4ZkfXmL+qkOnW6LSSbFUdbi6qnj5XIN/942Vv/7WMxx57AtffCJXHsfx0mBSRGEWa/po1tQrzWan14p1a66xztZNAhIje8azZDKJchRah3S6Ppcvz7G0zNVEIoXfCd60nRmM1bTbLcIwpK/cByZkYGCAjh9SqVWRrkAT9dq+SoGVArbawPZawerrn50bbUANzYam0agjZG+vtFb3TKXCItVWi1klkLLXMjQMI6KwSxh10bqLtRFvtgobLRkb3cXw0DgXL1wg0ppUOknP92uQwpLJp0nnPJZWl1CeItBdrNVsbKxirWVktK8/ihh/734d/Hyw4p1v7+X40DPnGnHjuZ83f+vqc2Ol/cdw/j9vft7r9+dNrP/9Jdb//hLrf3+J9b+/xPrfX2L97y+x/veXWP/7y3b1xwlqMTExMTExMTExMTExMTEx2+aanUpirpvQLBIDeSvIXzOCgEVYWF+vcur0FPfcd4JUocza4jKNxhLj4+Osra+xtLRENpfDmp7hzHFdjLkR4tNuQxD6pExmy8jWM7AhDNZq2q0Wy0vr7JoYwvM8OkHnukqsxHEUzWaHILAUCyXS6TTtdpuZK3O88cY0H/nIB7HWsrq6ysHDhzl69/1U1lfR7QaphEu9XqdYkncfmjz+vUgkWVxbxXEcRCpDs97FFUk6jTqe4l+MDBex0qKtQEgP5abQWhFqg9YB1comw6V+VjfWqTf9oFDkFWMtFoHQLhhBs2XI5kp89nMfnvWS0Rf+t9//4Qd27Wn9ywOHeLhY6FJbh+VlKBXgngfSHJjsp7IxzcSeYVQ6S3V5k0ajxdW5Ko0mJJNg7Qb5PAwM9TGQ76e2WWHEaVIqwcwUnHw1YnFhlsc+dRy8FkEExoJUBqHV9RSmrs5yaT3PQjDC4ECJgb6riM4MSd0m7awwUrjCJw+VMBd8Tq5LqiKiawfRZHttXDGEQtOWHoGZxNsI+cH5Jp+/8xCJbEQ2VaWtKwStl/itz3yB3//ai3SbGaoiiVaGCIcwVFA6wPdPfo8PTO5kXG2QYYMgqrGr0OKhiQqXq2e4YO8Cm0N7KZqiwJVajk0SSDODp0CqgJRoMFpoccXfIHJzhJEES69NnjAgAqSKkKLXIlZbAVJgkTh4eCZgwF1nJF2AbnMrBcvStZLlhktHDuDYDCbUSFEnZ6/y0FFN2ZumsjpHKQPlvlEu+X1869UAP/cQvnF6fTNNEte08VoXKPEyX3o4yZ7iLJvL83gKrJOBzBG++3yCqe4eKs4wOAVAgwVhJA4GbJM0q4xGi+yMfsR/9/ky0cYT+FGTWiMimVCo4hGmlgb58XMn8UKIVB6rQEqBlRa0wUpQLuSyfXQ6Db7z1EXm52DXbhgZylAuu0S2y8DQMK16g43KJvX6VrvMrX8McPjIDvL9Gbp+g5WVFSaPjSASy7zxesiZi2uM7gTjQLUKi6v88NLlxj/7B7/52efb7RxeskwYzaPDkFC7yNAS+CGOl3xleWktOLh3t4fxe59/YbCYrZ3oxt/tphwHD4k2IX4Qsbjc+PPaJv/acZI/0GGIdRIIKRHWgDZsbFRIJBKMDA3gtxoMDQ2xsLDAzMwse/fu2dprJNdsPL2LtAaLRpsIx7VbiYYWTG9v7Pjg+y1u2H+2bkL0jrXR9WOMjTAmRJtealqkg95a1BaspN3uEukAQ8jdJ+7gG994nXa7RbGUv8moizDkcjnWVmsI5RFFGoulf2CApg+5XIpEgmFr9bR92z6Ot/ZUfPsei2KbfyN9a/Lcrfd/6vFu0wvynYa33NSd9qZTfvdfJmyz/jVD9rusv+35NzeK3FRf3FL/3Y/4zs++z/P/8z5+m8sXK2L92zo61r+9AWL92zs+1r+9o2P92xsg1r+942P92zs61r+9AWL92zs+1r+9o99j/bFBLSYmJiYmJiYmJiYmJiYmZtsIy/WWhcBWOzpDtc1OmXYyxb4cdLu9Bogtn29/6yXuevAYOw7fScNq0vkSrtU0mw3WVtvkcyFY2UtMs+AJBVaysrJENptmzx7D1atXGX9gN/VaE2MtUhjAx9iQq1evkkwm2bt3P1FkEOJaahIgJN1uyMLCEoODgwwNjTI/v8jy8jInT06xe1cfxVIRJRWf/OQnsVJR2VgGq3FdiTCKQqmfyDjuU0+/lvrAI490yvlRtHAIhUO6AH1jWf7yT/76sS9+fGgslU7R1B20kyPlldEm1Zsn2zOYpNLuVmKSpeG3p47ecce6tQJjBdIkMMLllZfPYp0NcBogYMcunl9a4mN9A6xMTu4pDg1FNP057n0oSakkqLXn2XVggmYl4I2Xp5i50jOlpXvhWTQ3QUcwG0KrvcHu3TUOTI4xMOhRq1c4mFZ4Tplv/vUas390il/58n727Uny2ms+UpqtBCgXayVtPciimaRWP8jicwt87t4RPjiewamfIQgl9aU5DvW12PnRSb57+izfPjPDJX0/YeIw0qYxgQUXyGQh9Kixkz97dR6cFL98uMX6wvM4WUhlVxi33+YffeYe/oc/fZaKBlPYTdgKUEmX5dUqRXWQ517f5B8/fBi79kN0BNlwmc8fLvH6+XmW24eo2QzGzVCVfby+kubyRobBwUF0cAUroZTvcmSwzqXFaTa8El2ZuREXJHyQPsoJEYSYKCIKQ5AuuWyRoFknWF/nA8c9RuQymBrSkShl6HQirqz5dGQfCZklZWqU3FX25Na5c1+GnNdgZDhDrRWyYbI8eXadq439bBiFk/UQ1qLcLDl3hUHxOL/1OcWhPQGt+RkIIhLZPA23j2+/VuOlhUdoOg9gtUPCBbw8QcdigwhXtUjKJfq6z/OrR9b51CGQay+TMh08G5EpJaiLfby4sJe/OLkX693FmPkqc3XLnkhgrGazqknmMzRasHOiDyn6+ZtvT9PuwsMfzuN4HRwZ0D8wSrejeO75K6yvdsFCoQRCAgICDaEPly5dpa8PPvzYMXJFn43aEiN7EiTyDi+80GJ0Vx+hdXjp1ZXNtTU+eueRYvjqc2cwJo8wCld3eqYlN0fbX8OzloOHd6xX61emMOnD0nZQQiNsBysjuh2fYrmf1c1N1lYa3LX3AOVCkfNzZ/n+Mxevbm7ynw+NusHi/DoHD+wCHfZMOcKgjaXbbmMiTbGUpVpZp29gEKRgfnGJPfv2gXXpGdR6bTnDsEuhmMOYa204e2lpmQwEoabTaaE1CCnpdFooz9naEyKshUiHRDpEScPG+ga1WojrrNNoNnBdgY40IJFC9eY10LQ7dZZXLnHvw8cplzNcvjxFqVTAmJ6x0EoIw4hkMo2QAZWNFtYIhLJIFFJEKBkiJUWsBqve5rL2liNImJvv34Ix27uifS1x7hr6FiXCvrMBywpz6wPv+Hp9a/3byLc3OabeDbe88Bb9b6n/libaN+u/Xf2fdv5vrS/f8r7aW37Im+6/hVvn/yesk59U/9/3/L+Fn1L/7fiZz+/6A7H+7RDrj/Vvh1h/rH87xPpj/dsh1h/r3w6x/lj/dniv9ccGtZiYmJiYmJiYmJiYmJiYmO1hJdZ6WJsG66EBL5nE99coDrXvTuVK+JHGxTIzc4Vzr09z4u5J9k0exI8sYRDi+BHlVILpqSvU6xAEIcZosBIlLWHYpRt0mJ2dZ2RkGCEEszNXaTRqCAnWSoy1IMKtFnWbDPSPkE7nqFY3yCTyW66YHpVKjU6nw8DAAD969lla7TZBEBCF2NXVDRxHiijSRGFEqCNKgyOE3Q66Y+l2QzqhwW8b/ADR6mg85aGMg5G9lKao2+DIodTvDA/1IaUktArhJcBJobWDEaaXsWRBYtBRhJtMsLSyMb/38D60tT1DjBEIFFgHg3P9ulKhMIaUteDU682H0rmZ53eMlfPDOyDCx1jIpFI0Kg1+8P112nU4csRleHiUdDpNo96h2w3JZPK0Oz5LS6vMzrdYXJjljrthYncZipL11Ra/+LkJ3nj9Co9/7xLSgeFhCMI2UliMVYCia9I0nQk6hQc5u3aWjadOU72zwKeOPYI/ewbjL8LmAlFjiY8feYBCyeUbp05ztW3w1X7aokikFUgHK8AXedaT9/LVF59m38Aw9+6+g7B5jqQKcbjMgXyGLz94hH/z5NNs6ASU9pKUIMwAS639/PDi63xm0mNMZVGqjdQblM05Pnvnfl58aomaewhCn1CmqbCTs8t1HhjPIQxEFqRtsK+vQ0kusRk1wWS2Vs21VKsIqSxiy/RhrMVKQ7fbwTMB5aRm35BLTm3SsF2symBEgivzAV2dp0saaVzKiZBS+BqPHukwkqmj6ysEGtK5MRbNQf7m1VW6iSES6UFMUEfqJrZ7GhE9xy99pMXx4XVE8wpEEeWCi+8M88ylIt96vcyGOEqHUQxVgnYLmuAoyHsbpLoXyesz/NZjBT4zZij6F6myyXq1Szqfp7DzQb71bMDfTGdYyj6CiOqkomcIRIOuaaGsJVuUWOGxY7zDqVMbzM1sUB6Eu3ZnCU2bVNqjXOrnuR9dYn4WUg4MDaYZ25Ejk3VIZ1IEXUOkPRyZYerSHK++tkat9TofeWyccn+RWqOOm0lSHoLNesTaWrO+uspDR45kQkwSZRyEBWtNr/WsAU1IpAAbIKyPDvV8ox0dLicdJBorIxCCfD6PdFy6fkhfX4p0IsHSlSs89/xFfJ8X7rnvgfbJV057kbHrqyuV/v5yESUMCDAmpNvtkkmne2Yvq6nXq+RyORqNFpVKg3KpvLVWenuO53m0W+3r+48xUS8Qz2oajSrrG6scP95HvV6l2+2S9m5csu0lo+nra61erzI8ksZRHqury+zYMXb9tUI4W8dEaBOSzjoQNDh2xxF++OwLLCwusmvnTmy312Y0irpk0hmiqEql2iCXA0fJ6+0TIUJCumeUc9/B13W7K9TbTPB6i0HrFm5jwLLyNvpuL2A7T7+L8W83wm3O77bj/3zn/3aJdNueob/l879ttnt+sf7tEevfXoHtEuvfXoHtEuvfXoHtEuvfXoHtEuvfXoHtEuvfXoHtEuvfXoHt8h+5/u397zQmJiYmJiYmJiYmJiYmJiYGh4gsoS3Stf10bT+Vpotx+8j3F3531/5DzC1WePKZFzl9apo9e3Zyx/EjONKADkh4irHhMaamLjM7N8ehQ2W63S6R1ijHIZn0kI5mZWWBVjNi186DjA7vIYpg7uoU2ZyHRQMGawTWWjqdDvl8HqMtRoOUzvWbEIogCGi1oN1qEQQBQ0MD3H//vdx3/z6xvIK4dOk8a2srCGkplcsE7QgTKP5/9u48SI7zvPP8933zqPvoruoLfaABNG6gcZAAeJMiKVISReqyJVkj2Z61Y+31OWvvRqzXno2xZ3fHdtjecNjh9dg79uyMJUu2DlI3RVKkQIAACYK476vvu6rrrqw83nf/qAYJXrooGZ51fiIq0F1dme+TmVVZiMpfPa9pxIjaaWp1j1giW5fgpFOdXJ8+0NQ+lnb45pefHoxZvD+ZjKPQKKWwbBtpmviq3e0ILRGoV7sD1apVqhUmNbw6naTUCoFCC9CYaG2gtaDle8STafLdnD12TI0+8eWlQ05T0tnVQaUOttnJoQNLCA3veXg16waGUZ7B+cvLvHJ2QZ29VmRiboFYxGHblgx335Vh01Z45Qi8fKRIoVgjlY3iiTl23z5Adw9MT7dnG/QDF7ES9hMYeAjGCrOUkTjWGmb17fzVkU385fP9RHJ30NUxROBA2gbbOc+j2+v8xt5pbvW/SLx6jFWdaewghuFHEbj4BpSCDOXMPv74O5ojzijx7rXEI+0ufWnvGh/dcpZP7TzLKi5gu2Xclk/L7GIpMsKR+STPnWvQMPuRyQyaJklR5PYNSUZi8+T8qxBMgeFT1t1cnDNwpUk83s7/SaVZPxShw66iGgFeK4qUNlJKhCnBlEhj5SYlhpTowMNtLmMHy3SnFENDHYhI0C7Y6sA3t3B5PI7yO5DKxhUSxxlnKPsKD4wWSOpJLN3+oK6lu/j6izEuFDcT6ehDyTq+9olYCwwmv829I0d4z/o58vUTiPI8McPAjndwpZTjPx9YzRgfpckAoPCkQkYtjFiGqKjSKZ5nc/wr/NYDSzwycIXWwlkWC0Xq1QrZntXU4nfxXw9l+dsz6zhj3s21po9KKFwsfOJoJEJqbMtGCkEinmR5GbKdsG2XQaNVIx5TxM1+nn1ygosXYNNmeNe9ebZtz2MlE8yW4eDL0xx6aUKNnZ/DrZXYsCnOT31qPW4Lnvv2FFLlUF4Cy0jSasI3v1p+4aUXWqO7tveek34SdLR96hE+Wrp4UtEyoSkUrqnwLUlTBBRb/uRStYoW7Sk3pW5/21cYBvVGg6mZGaLxKNcmrnLi9Al27Ohh7XDk0VeOHl51y61b3PGp+imkgcYEZPubwkrTaDZJpdNorfGD9hSb+Vw3i4uBvnBxnFZQR8kWSoDCJJ6IU6mW2ucgQ+IHDqYJge+zuLhI4PuM7tiO47hMTFxDtAdambK4vX7TFARBwOJike7uPIYpmJ2ZJxaN88aPeH3fRytIp9M0mw2GhlYTixpcuXIJ0zIQQiClxgsC4qkkvuczNzuH1hrLslBKoVRAoBQqWCnnnzEtvvvtn/v6w/H/eY//4/bf+vaF9d9cYf03V1j/zRXWf3OF9d9cYf03V1j/zRXWf3O90/rDDmqhUCgUCoVCoVAoFAqFfmTkypR2EcvmlZfO5m65tbt1YP+Jr8yNlb+TjTFyz97BX9x1yy6azTqOrzBsg6idolavMzMzS1dXF+l0kqmpqXawzJbYdoRaqcy5c5MMDw/SkU0TKMXAwCquXp1g/Yb1vLFlvW3b7SkzqzVisdib6oxGo7z//e8inU7jOA3q9Tp+4JLLdTA6muHs2YtEowbxRBw7kmB4eBvpWJzOVBSjI0G85rC0tLR45133qEALNO1p2Ax8DO2QiPHHu3dvwoyYVMo1kpkIhpQEvo/rBURk5NVahAbbjjI3N40Z4ZrnKYSpkNpH4vJa+MQEFQWhMKSJYRrYJgz2G+ObN26549rYKddzDMsyJFcvL1CYh1t2xymX6lw9P86ZczwzX2IhnubR3lUkr5xv0pdHb96C6F7VSVdXJ3feFeP06Wn273d49AMdZDsDCoVpBgYzOK0y8UR7ur1ABWhtrNQmyXXmKcsodSHRyTyeHuTZsZeJ1E7yoV3bGBrpYrlwiqho4E8fYjSZJXXvMF+8OM/BqafIiq00ZCe+AIWNLzMsupLF5jb+8punGfrwOjYkXFr1cfBqDHeM88l7RzlfOoFbijFWXQuJQax4HzU9zDfOvMyurf1syLoIp4Tt1+mKFLlvg8niubPU9RYcP0lDdFPWDQrVMwzmJDgK1XIYzinS1hK4DkIKZESuhHokGCbgYkgDQ64cG6XBKRMzlsinK9iGg1Ye2oTASlFs9LDU9PB1Eik0UauOUb3EnZuaDEQWkNU5UjEbJSJcbWR59oyJm9pLsSGwIi7KX6Q3PsWt+XP8m0cz9DeOIJoNXAGtaC9Fczv/z7PLFBMPsRBsQEvwDRctwPAbJP1LmMXn2TF8nE/eYbM1cg3vyhVsK4EroqSH9nG+mOaJEwZfOe3jrrmfciMFUUmtXsHXMXxMAl3BEOB7LkFg0aw69HTC0DBUawFbtnRRKcEXP3+JfA4+8IFebFNiBFEuX5rg4jVfl2qIbBbGL9HwqqWvdPWUevbezf19/f3ccds2vv7N05w9N0E2m0AjKCzhrR5I3Kn9DIaKgSHwtW5/aVi4gEBqjdYGknbfMkMKAqVwW4w5jQbQPmcIApAWjWaDYqXK+GSBgd4kc9Uy20Y30zvci+OfiVy1Fv6ksDz58VKVg4VK9V25bAdSWmjtoLXGdT3isTgAWmvisQSNqE/LRc/OLrJc7BbdPfmV163Ctk0qlRICA0OauJ6HNASBp6mUa0QiEdLpNF1dnSwsFNn8urOVIgg8LMvGdwWVik8m3SIaMwl8geu2u6F5XrvLmmVZaK1RCuKxOK7r4Tot9uzZw4EDhyksLZFIxtrBWKHwfZ8ARalUQus8Uhqvnc/bwTTv+34DCIVCoVAoFAqFQqFQKBR6G2FALRQKhUKhUCgUCoVCodA75BNRDaIUQbYDakJL7tq9pkJg75NNl3/1qYd48hv/+NBypfyLTquCkBCxJCiFcD2KiwssF4vcc9+dzM/P02p5WKZJJBJjdnaBQ4cOY0gY2TBEpT6D03RYNzLItbEZjr50ju2j21CqHfq4du0aQgh6enowLEWjUcVOxwHR7rAm2l2DlPKpNaogFJ5ugQakYt3GtWzaJimVSszNzbNUmKNcbZKwYmRiFpFIBOwoliWOKFoo3UIZElNobBHw7SeP7LxlNPWTmbSFp1xagU/WTCKExFcKISRaaRQaKQRamDgNRSqZwxClC9KQ7Zb4wgfp8urHNyqCkEnQPq4b4LoetpUk8BRRqxvPEd9eWPAf3j26lf1nTpFJwfDQes6dm+T4ecoXzvG50W186sMfySdz+SyLSzWe+OpccPpLvLR9e3HPHXetsaIJwV33buXbT53hiS/N8hM/maevr5PykqRahe5ekKId/lFKIYD5mXlwTFRL4AQBWgXYIkY1vo2ny2kufucIv/ruAdYkKujmGJZ2MU3F3uFu+nIz9B8t8Nnjc4jMvTiqB99Mg9T4SKz4nYxXYvz1E8/zy4+O0ptQBNVxlkplcrl5fuF+MJ56mmblA8zXuvAiDWSiixOV1Tw14bJ2uJesmiPwXIQ7yQf2Zjg1dZwr0wmiPQ8Q2J2cvnaGhptAWFk0RXDrRP1ptg5Y7J+ukUjE8bwCvlYgBZgGvhcgIxJpGASeRzaRoekqrNYF9myNEzNdtNbEEgnK0masGeX8kotnRCEok40W2Lba5aHteTr9CXwFUnRSMfO8cC3gci1PI7MGt9RAust0GdOslmf4tfszdC0fQAZFmgrs7jhT3jB/9lQfr8j3sEgvjnQxYuA3ylhGhE61TK72NB/Z6/DRfRni1WPY9QqZmI3nuTiJtRxbWs/fn5Dsn++iOTxKI4hCxADtoz0f348zNTuLN2JhISEICDyXzniaglXAtiyiMYkMBvnsp1+huwf23NGN57Vo1lIceG7Me+Vl9dLoVva978GcmculWRytJz//+EL/oWP83WKZW979QDMzvK6LvkGYmfbYsWOEk6cuMzvDMz05C6RNywlQUiEMCQI0AQYS029Pg+tJjRJguh6dyQ5Ma+a8V2pikUUrjRaaRDxGaamMbdvce88uJIrubBp8h6XFWQZ7coxuDz724rH5/0EY/N9Ts3O/s3nNCKYIUMIgCIJ2g8PzNHePAAAgAElEQVSVEJznKdyWZmZ2hqFhIfP5Lo69cp59e29jeG0P5fIyXT15iuUi45OzJBIJ4tF2J8WFpQUmJms88sjteIFiYGCAa9eKLC0t09nRgWVHaVSrgMIybeYKc9RqkEjGSKfTHD92knK5TEdHjiBwgXY4d3p6mmjUwjAsWi0PU0I+nyeeMHnpyCt84APvpVarI4QgmUwihAxmZuaNTbVeUuksEkE8ksB3XZJxSo2A7z5NxzucQvJ7eqfr/3HX9+N2s+sP9//NruCdCeu/ucL6b66w/psrrP/mCuu/ucL6b66w/psrrP/m+mde/z/v6kKhUCgUCoVCoVAoFAr9N0HgI4SDEDWEqCFFA4nvSS1ROoqnbJ47QNPTmrpTRwoXQ7tYSmFomBgbo9F0yOfz+J5HT3c3rudy9OWjvHDwBRYXFdu3b6OnO4/SAbF4hGQyzr333M7s3BzFYgHbtpFS4DjOSlHtKfKg3eXotVoNpBAI0Z4O1PcDIhELywLTFBiGQimfbDbN9u1beNf9d7JmbR+ZDotGa4np2cucO3eahSVNtiOCkg5WzEBLje/VGOrnC0P9ObRy8AKPeCaLMEyUCtA6wDAMlF6Zwm+lniCQLBfqNJv6sG1FkVyv3V+5wfUOaoooCvnq9IFKR1EqxtgV/btT4zWWllwMCwwbFuaLXL1aRPnYm7bwHz/4obV3x6Ims9PjWGaE97//HtNrcfL5Z9n11DeuLZXKLaRpsPf2NdRrcO7sErFk15s+4FJKvbpPpZYYgY1UURAST4KjDaq6gxl7I1eNvfzlUy7HFzcgO/bgGyniaRuvdoEe/QqfuMPhU7cv0+c+RU9slqisgQ4IdJKmyFOQG3hhaRP/5UVJSQ4jI1FadQhKV9ndO83Pv8dmIHKcoc4CqbhgqR6hFr2NAxdSTMzF8II4WhrgFeg2L3L3Rpe+aAnTb+L7cepuhtkFwM9gyDimcOmKNRjM+sSsJpbpEQQuge+vHDdNy2/vAxUEeJ6P1/QwtUM+OseqTBlL++jAQgloCYvLS5KZVpbAytCXj2JWD/GuLYqRDhczqBE1NZ5MMeeu45mTEp3diCdT5LpW4S5cZsQ6yy+/N8tIYpKcLCA8jRIRiuZGvn7G5vDCeibZQU2mEKZGBA62XqY7OMN6+SIf3bXEB7YWsRaep0MViQmPpbLGSYxyZGGQzx5LcbSyhUrqdupOFi3iK89NhRAGvorhkUQpi+sfJ7aPu4UNuE1NPjfAoedP05WFu+7qxTAkvpPg+Wcnlp79ttqZiHPyg4/dZXam88zPzpDpiPHwIwP33LqPv8ykscvVJoYp8DzIZMFzNeNXS7Sa/J7SGqU9NC3AR9MiEC208FHCX3mtqJW6QAeKuZlZnIY+vDC3SKvRagfUtKbRaNKZydKZzdLRkSXb2UmAjxIKA40hAgb6kvR087UH37tupuUH0+Vqpb1uaeJ5Hp4HTr1B4HrYlkUkEsMyLSzLZMOG9QwMDPLtZw/y7LPPks4k6e/vA2BiYopVff1Eo1G0Dhi7NsHqNTnyuW5qtSarVg0yOJjh7NmzRGNRAtXuipZMJqnVq9RqDRJx6B/oobevE8u2qJRrqIBXX6NKKSqVCktLHslksh2oXbm/r7cPrWBxcREpBbbZDr8KIYqNFtONVrtDXLFYoF6v4zotmnWu/dBvDKFQKBQKhUKhUCgUCoVCK8KAWigUCoVCoVAoFAqFQqF3zDfAlxJX2riGiWtIWqbCM1w806XSaLFhMzOOG2CaAq090C5CB8jAx3c9urryNJsN5uZnGZ+Y5dy58zhOk2jMZng4zurVg5RKTZQfxTazNBoBfavyrBsZ5IVDR7l2bYxkMkWus4vrYZU3ksZr09ehJUIYmKaBaQps2yQSNYjGbKIxG2kIWq0m1VqJdNqgbyDNlm1D7L1tE9t39HHPPR2/9Oxz+z/31//pOwlfe1QbFQ4fOvnp3aNr1w4N5NGqicbHitgIwyBQCqm5IXzWJoTB/FyBWs156c7b904JpRFKIjTtLmrCXwmjSRQ2WtsEQq7cTAJsvJbBRz7y2KHTZ/2/mF906e7vZX4JPK895kAvsQ8+dqvwtcGh43McPu5x4PA4s5OLrO6L3fbxD99x5ukn2fXkN6aLxeVlMh0G9z+Y5OXDcO1cDXT0+nR/INSrYR8hBAoTraMoHQUkSkIgJK7UNEXAolzFEfcx/vTwZr54uYtSbpSiaTFbcZgvzGHVD/Ozt53nf31sgozzWZzl57B0Ay0kyvCpRNJc7ryHL80M8sSxJk0GyaWSRB0f6UyzY22dTz28jFr6G2yrijCGcf29TEyu5egpRRBZQ0tECFSdJIvcu62DDX0KyyuAC9rvYPKqh9NMELFjRAwPKLNlOE1HyqFamyAaEUQiEexoBCIRIiu/RyIRYnYMp+FhaZfu7DJDvS5Sg9JxtICWYXJ8KmBZD9HSGVq1OTZ3XuaBrWUstQDKg4SPTnRy8HIfL42txjd7Ub5HXHps6GzwyVuWeXD1ZYLGJQIBpoBMzy72X93IPxzJUwwG8bFAKETg0eFbbLZrbKx9hl+/9wo/tbdKrPkKyaiiEWiUnaRj44P84+XN/OGBfp6c38SssQ10BxADV4CWaNE+lp620ToKmEgMAt1+PkotsYCufB/jYzOcPuWyY3QNnqdplCRf/fxU8cSL7Pzw+7aeXTPUecflsTJf+OoFTlxocXVyke7uKI8+Mig7u4lVak0Mw8BtwvBgN+fPXuXFF/iLu+5Yf0ipJkoUCCiDUQPhgHAJDB/fULQMaJnQMhQtQ1ELXIKIwZrNw1OBJY9U6rVXX2/1eg0hJAITIUBJBVKihUIIgWkourtT7NrZd/s3nrryR+MzzueXlpYIggDDMPF9hedBpVLBdd2VDmS6fS4xEphGjO2jm9i5a4RCocCXvvg4586fIR6LsDC/xLVrE0gpmZ6epVZz2LvnNqQhqVWrAKxbt46FhZUQmRArAbPXnzMMQxGLRzCkQalcodVqvfp8bLVaNBoNhIRyuYzv+0hp4vs+q/r7CRRcvXQZiXg1vAZUqlVeqK7U0N3bg+M4lEr+lJRM/NBvDKFQKBQKhUKhUCgUCoVCK8IpPkOhUCgUCoVCoVAoFAq9M8KkRbodolrpZCSRSCHBMNvd1aJxiiVmZhcay+VytSOWSyI1GCuhrYX5ebp78gB0d3ezevUQUkoGB1dz9OWjJFJRpGHQajhE7BggcRyH4rLP6OhWgsDn2LELFJdnGegfeq00DECuhKlW7pMCtEBIgcRAE7Sn3dQahEDKdohNSollmejAJwh8UB6mAdIQ2Jaivy/D/R3pjxr2+J4v/f0zn+ju4OF7b131idX9vZjSxW06WMkMKEUQSISW7Y5UgYsBCEPia5MAk/nCHN94avkPPvJTBn7gI432dwqFloAJ2kRhgzZQgNYuaIUWAVKbKKuHYqXA5s07f/k//tXxwf/pV7c92tU9x5nzM+zbu5cXXniJanmReC7C8VPwwLt70H6Cb33tHJVlfm/9phS//j8+MvXX//lrH1p9fPI7t9yaI5mM0JGtceKVKW67bT0YYBggpYFhgtcMEKZAei1iukhcFVnGBZ1ASdCYCBmjqlOUxRCun+Ob5xuU600evWUX6dx54u4yor6Mnn2Zu4e34T66mT//6iHm3DgFNlAlDjJO0DHA5Nwsjx8+wa39/WwY7iFYOkql2sSwLnD3yBCX91h84cRhovpeWn4eM7OTrx97lj27V9ElZkjJOn51iU1rDO5eHzC+dImm203MzDG1aFPx0mSTDUy/Ck6dXMpjba7MQusKZqBJqQUspUDboE1AgWwgjCKGe5GYZdMVnWNVZhCj5QLtAKFLlolCAuKraVSW6LDP8NhDUQZTVylNXCBlgtGZZbyW5guHmrjpO6m7NvhTWMVzPLJjmQ/uA1k+gt+s0tIm2Z7tHJ7u4W++pVgQd1ETHYCPoEE6KBEvXGF991V+4aN9rE2dhvo08ZSi6VlEcluYc/r59LdqPDMzzGJqH67Zh1vXIDWxSARHKdA+QoGpXSK6hunXMJQiCDTKFO3pTkULA3DrklMnmqxZA7l8mkq9xXf2z3DpKh/61z/z8enxiaucv1T83YpX/OJtd26iXBvnW083+NlP+izMz9JowL696zj8/Cny2QSNaop/+McrX77/Pbt/OZkcwLlaAkALiYGFQKCRK70FJddf3MHKV3HNmIURaMpBiyOH/D8Y3cjns8JGAq1mAyfSIBAmnqEQpkAYIJEgTUSgqVWrZFIJbt0Z+c2jL7cuVKolFag+aUibwNf4HtSdJi3PJZlOUW828PwWWhloJTBsuP2OfUSjUZ5++jTxRIG+3lUY0sGyTBYXC5w7c5mtW0ZJp7MsF+bxfI/Z2Vm6ujoZXh3j+LFT3HVnlmQ2yfLyAsl0imQqSr0Bs7NLRCMZgkDgez5+4BM329MYtwNpkt6eCJOTk6TTadLJNE7TIR7toCOToVCoUK/VSHWkCVSAr0S51uBr9XrzJ30FLQ+m5kr40vzCbffcrb794ikC7O/xRvDj+h70W4eNf3Tj/7jX/y99/Ju9fd/LO63v5m+fRv5Y1x8KhUKhUCgUCoVCPyphQC0UCoVCoVAoFAqFQqHQOxTnD//q67SnorzhYu31aSFFhW995g/4pV96rHngG1+e8T3RoZWB1hqN3w6ISUkqlcJ1PbZv39IOaQmLmelZFhYWuHX1bnzPIx63kFIihCCf7+D8hXPMzswwMjKCaVpcuDCG07xM3XGYX1pk1apepGlzY0hNCNmuUgiEoQALjQINKEnga4S+cQpLEylMMG0kAWhFPJ5CoUknTbrvW7fmdPfkoWw2T3dXBq18HMcjEe9EWhamab66byQ+phJUSlVMO4KjBYE0OXG2sH/9Vr547MRxfCwUoBQQWPjaomJoXCKoIIGnLXxloIVAyQDwicYdejrzKG+evbese+w//c3p/2XXtsi/bS6r+OWxMtt2jDI5d5XyVI14EhxVZ3jteorO1S9tHN3ypXIrwFl2efi9G/YfeO7isYGB2q51w13svjXHwecLHDl6CcuAWDSKEAZRS+DVFTgBtrPMUOQKbvMl8rGtVI0InpQoLdB+O1xHAmpeFxeX76axnKcwc5pPPng/2fgJlHOaqBXBmb3GXR01Vv/EWr5w7AiPnxqj6t4OXdthsUKEIRb4KH/w2WcY+rk8G6I9mM156jMzbB02+Nl9Q5TmL3Nw3KJq7mERybIzwleu+PzsniGaizPQALcwxmM7uzh6/DTN6ibiiS7GKmnGGym6VylabhHX84jIGtvyM0xePkPE0gyqOktjLsIu4BseomuZydoZOjN1ekrPEjg+/ZElvOWAqjdFJGOQTK5i6opgqdRLoLJ0pSbpt09y7y0QaVwgloKGZ1ELVvGdK3CxMYCX3Uy9tUzGOcEDa5/jNx/rx5t7kUZQJxtP4MY28dzsWv7syRYXyjswh/ah5+bBWiYZqZNuvMhPjs7wod0BA7lpnOocjVYLO27Ss2mUE5P9/B+fgzn5EKVEloYwifguphVD+Q4oiQ4CojET25ckWhU6uEZKLRLULbAMtGmC1PSuyjA7V+DsqRmaNRjaKClXp1leFkxNcez2d+/ef25+icnZCmtGt3zp+MmzX/rAJ3o/5E3OEIk3OfjCGNEI7LttkNnZOnNTHl25gfrn/uuV/33Llg2/X2gmODezQDkYAR0FfFrNBggfrQMEPiYuM+NX213rrodQFQjA0BDt5Qv7j07uf2DfyD3deYNkwkT5HtJaCYEKQYBCSgMtLLRh0qg3SXWkuWvHrfQlrm2cnJjRCz157OgqHM9n1WAapRT797/IbXfcQm/vAOlshitXx3E8l1S2i3qzRbPlMLw2wv33349pWkgRw2m6PPHlL9LR2ckte/bhOg5SWhiGTS6foVSpsGnDZp588hWe+fZ+HnnkQbLZDoTUpFIxmg2YuFZi47puUskcjtMgnU5jmpJWy+PQoUNsHFmPZVmcPHWGxlCDZCyNFAmqJc2Vi2VMEwzTJGoZtFotikW35LgcrjZdFCZuYHLy/Bwvn/f/tJn0OTvuEog3n9uv728leNM0wDd641+kfsuHvY23DwD9aMa/Yf0r26jesMQ/2fb9E4/f3n/q1f34Wi2vX2N7ffINv9+w/7/bIEK9qZ63ru+19b9Wz/exfm7e9r+puuuvkbc8Vm++7/vaf2+55I3LmZw+PQU3nP/0G/ffD/R8fLNCrfDOVvAO5ZK5mzr+zd7+UOidCF8/oe+mK/XOnh+LteJ3f4B+h29AoVAoFPr/pTCgFgqFQqFQKBQKhUKhUOgdMoH0m+++4aKvEvL6xdt5kFvbHagChAahb7yo2/5ZK02AT6VSQUqTSCSGHwRYUiIkqMDDME0816XWarFhQ4z+/n76+vJcGxujVHFotVp4nodpmiitMVa6LAkhkOJ6YM1sB8GwgPa6AaRWaK3aV3YFK2E1hcZAKY9IJAbCRygfO25wx64NBMrC1wqn2cQyTCKRCNI00EIRKAFaI9FIAcl4FNe3UMrkwOFTC77gfT4WWsiVXSDb+0ObKEyk0oCN0lG0jqGVxJegtQPCJ5GM0/JK2LQwRMDG9fbvv3K09ZxU/MSRVy4Mb93GzrXrOtfF0t28a8cqAsPls48fqHs2v6FjEVqGQkqJ1nEI+HS9qna5vsKIKOJpKJahMwumFUfrFoYQRKTEbfjEVYWfui/OoZkxjkyVWXQHKVk5auQIVBdKW2A2UWaMRmQdc26Ul2Z8Cl84wc+/fyO3jQzRmj8FtXEyfp3uLk3XA10E3hhfvADT82Vi6SFQSUpsYVY2+A9//xn+9NfvJOq/RKp+icrsJNuH0vz2x3by2399luPNDC17PQvNjXz2+YM8dmsPqzu6MK0mJnWG43O8e4vi0tjTSJVjuXqKCxdSpL1lLK9ErQ6Jrinu2ZRmy1APg71dxPwFhuQ0XjmGMD1AMNRl89MfGebh2jB+I6DHvYDRmEOrCgsLHm6xweRVn8aMJptxSBhn+djDMTJcJmYEEI9jqH7OLw/x+OEWFWs1ngro4ioj8dP8yiMJ8t4LiKxPcUkQ61zHlUI//+VZxWXvDnRmN+VlFxFx6Y3NEy2+yEd2Bvz6g1FSznHmFs9RcxWRdIrU4G187YTkHw44jBnvoWCsp2U6oCW2b2MoSSAtpKoRUQUy7jIdLLK1b4l3dfdgLJ6nUTLp7E/g6gpCatAOGHB1zCOTg0TKIpNNMD3RoNnk71wMMA1inTmcVpnOLn7j8cefe+ju2zckHrivi/npZQzD5qWXJq+cfIVj+Szjp05f+fyO3YOHAxNqTgERyeKrOEqlQfgEKgbCBe0i8VGiwfXLX9eDI5p2SMOX4ALTBd734vHLV957/6aenq5ulorN152qpJYgNEgDtCaX76VWa2BYgo3r1rK8uCBOnDxHPJHANGyCwOfWW/dw8PBB9u8/yp59QTtEZkrqtTod2RxCamZnZ8lkM1QqNfL5bopLBQ4ePEw2k+Puu+4D0wZclAqIRCK4boBpmuhAkc+BG8CBgwfZuXs76UySfFeWtWttrlxe5tbdTVLJDly3fa5zXc2hQ4cwpGRk/QjVau3V8x2A6yqKBQfTiB0MdNNp1N0HIhGHaq2FFY+fGt2duWBHAko1j7rT4vDR+m9t37fnWpMYLZEkENaNe6y9n18N2Mj2efJ6QFC/VcDnLd4a3o54Y2TnrSM873j8V8dRr/tdvzEgtrL+G9b4/a3/e7nJ4+vrgbjr4678+6b994bxrv/9+rBvDEa9+p5+ffk3HM831/f69b9p+7/HBt2s7X+74/cWkbk3DPy99t8bln6b6/vt4KJJiyJamN8loPb9dnl7G6LznS3/DjnEb+r4N3v7Q6F3Inz9hL4bRyTf4Ro6vvufv+//EIVCoVDoX5IwoBYKhUKhUCgUCoVCoVDox+6GC6zVG+8PVjqSvZ7CDzxAsrRUbHf6icZQgYewBYHv4zgOmUwGz/MolcsATE9P09XdwW37bqfWcDANi0ApXNdFBQopxKthjfYFYg1opDS5nkyTN9SiA4UWGq1XatQBGn/lIrRamRZU4rRc4skobkvhtRSu560EWQwEEl9ptBZIYYB28ZSPlhaeNBmfKjK94HzME0ZdYYJeaeQm2jctVXtMbSBXOrAJXJQ0YeUxFg2ke4pYdIlr1y7865F1fDSTYvv2URbcJmPTM5x/6Rh/c+J88eKmrakPHjl3dtPMknul5fN3t+7ZOlmtVUmbMQLDQGGiNC+Wih7NVoAdFyRycGkMoikJZhwvaGISEI/aVBebJEzojx9icMcq7ujNsP/CMY7WNjKpt1D0JUqnVoJMPo6t0aaNSN7KmVaO//NbF/npd5nclZ+mp2sO329BdZp+8zC/+cAIfR3H+PSBk5T9j1ISG3ANybwxwPOlO/mDrxb4jXcP0BGZwtJNGosXGelM8ouP9vNbXzjGRCNKIr2ZhfIMB89eJL+zn4RepFkuELNm2Dlocvf6i9iRGFt7W2xf65NJaJJ2nj7DJJbNka0vYMd8avUJspZJpNlAZgdAujhelYjVJMksvV2ChJWgw49gNdNIHaNWrdCyE2zqD/idj3qcu/YtigtnuWfV7ajCEi0iRIjQMNbw/Okhjk8IGh0dyMpptka+zm9/OMFoVxVnrohyfTq61rJkDPHp/WWOTuyjlb8TaSWgcIl8cJzVrVf47x/0uW99k6wzj1ebIhlXZLv7WdbDfONolj9/uotJdxQztQpPgiPjoG2ETmBpicIhEczR2zrAztQYd29qcMtAlKSrODVbp1YxYHUvuBpD+iB8pAGzc7BmvSQaSaKVRaXcoNngRV852EaAYYLvSPp6RsbGr1ze8vjExX9lmazLpsW5y5f1Ewg2DA5xV1cXmzbs4C+Qk93XpjlVh3/I9675W6G7EMoGFIb2293SaAfLpHh9Ny+4IeCx0lXooffdXf/2l5//+MlzE89uUQNEzDjX+1S1w2ntc4IWBoh2UFWaBp7XwjAM9u69heeee5Fjx47Rv2qQRqOJUooPf/hDvPDiYU6dOklHR55iMeDipYuM7tzN0SNHCALN9u07iVoWJ0+c4uqVcTwv4L3veR+JZJrZ8XFMU+L77YCa4zSwbYOpqSk6cx1s2LSFgwcP8vTTLzEwmGTTphG2bd/M6ZMnGB8bx/VbaC1wHIeLF85z5kyThx9eTyaXQwPCAMdzsWNRpLQ5c2qGmbnm/5zMsKtW9x6IxQXFUpW5Qvn/bc6UI9nsMCeOj3Pm0sS/v+eBjb+/0KyvdGv0aYd4Q6FQKBQKhUKhUCgUCoV+OGFALRQKhUKhUCgUCoVCodCPnRACqUBqghvv11qjAvWmKbGUCtBKUalUsO0oga9e624m2z/UGw0KhSL5fA7TMJFCcOzYCXwvINfVQ9Nx2tOLCROBeHUMIQwEeqWTmvFqfQj1us4lWmhUECCURosApVpoDYFeqUUFKK1BGCwuFDDtKPFYglQqdcP2tbuwtTuwSPzARWtF3fWpOJqnDlz5zoPvffi5p597HlYeo0V7KtJAqva4WiKUxMAjMFpIbWEoE4SJlmCwjIXP2WNXv/bYBzPvG1zdRTbVyfzscj/IXY2mYnKm7B89ufCbqa6eP8pYcaKdFRLpVDvgYntg+WgEGomC6UoNVKBRQhFLw1IFVmkLw4riOyBMgZYG1ZbCMCAjpwka0wz0rmXnmh08fmKWE0twen6OJdVDw8vQUgk806CJheMniRobKQVZ/uSJZ3Huy/ORW/bQocdpzE4SOOP0ddf4xO5B1vUN8qdffRJbVijIYVySqK6H+MLRx1mVafKRfSOk1BzZhMYpnmbP6gQ//9gG/uKbZ1j2ulE6xzP7L7NvMEePoWlUKywXTxHXKX7pQxsJ0Gzp3wBeFbdawzZNVKDQTp2Y5xBPurj1OWKZLPV6jYSRwanViKYSRA1FzPdoenMEdY2BgYzHwI9gW4pERyejSdiqWrx/W4ZmYxO18lmqhTK+HRCNakq2ybcPzdDT9x6a1SnS3iv8yk9k2Nc3RnP6DCYBhsxScvr4uxcafPVMknp8B44rsf0xhu3zbDJP8PP3x7lv9QR27RStpks0k8CPD7Ao1/GFAy5fejlgTN9BxRohIVwC4aKFxFCKKIskdAVbzdDJaT5+d4vbBmAkU8IvTFOrRfF98FRAs9UCLTBNQaCarOQqyeU6EVKwvFyi3mjSdJnxlSIiNfXGErZp0JHKEtu4ZSJG5D8I4WJaZVqtqV8b3bXpj1cNdZtWpIGiRjRpcm8q3n/6/IX3fP2b137CNoJHfNF+zRpSQRAgtUag2t3UbiD1a52JYCXwGUnw/o8+8NyhZ57Zn8837xnsSxAoH4XEtF/r3Hj9fFCvOySSSQI/YGlpia6uHvbuG2Xs2jUmJsYpFjVLS0skMwm2bdlOLt/L4uIi+/ZtoqOjk/nZWc5fuIDvebxy9BiB5xP4PmvWDLNx4xaEECwszBGPRwGF0/Sx7QSViotpRkin04yPz3Db7R08+uj7OHj4IJVKmRMnj2MZSXI5mJ6ZRmkH25acPHEC0zLYsN5AKUWlVEIaBpGIxfLyMr7nc/rcZcanZq7edvvOQy++fHxz05W0ggjXJubOr9s0eGxicn79y8fG/ixi8elMd+7FUq2KZ5m4WoPwX79Tr5/X9Zu7Nb2dN3aF+lG42eP/U64/FPoRue+Gn5+7STWEQqFQKBQKhUKhf6HCgFooFAqFQqFQKBQKhUKhHzupwTYtPJ9YEPjAa1PPaa3o6+tlfn6egaE89UadSCTCxPgUk5MOW7dmiccTIHyU8vBVgBCCYqFAqaS59dZhXM9lZGSEpcICLx89yb7b9hCPx0GvhKk0BGhQGtOkHVaT4tWJ4wxEO4AhX99hTZpWOwShA1ACP/Dav+OBkGghMG2TjB1HGCZCGARozJU0XTd4B70AACAASURBVHtqUIlQAqEDtFD4IiCWzXH2zDxLDf7Qzg7g6li7M5tgpUNbgDYCtNIofKTwkUJjtWccJdAGYCOxMahQWlz83U9+bOR96zd3MTu/yIH9F/WZM6XPRaNcxSK3aUf+Ew8/tuFPn3rm4vujifhD0VQPjUYNZTQQhsYwFIGnUFoTiYDW7eMTuD6ZVIJkZ51ktrPdWUpohGHSdAVFP4IjG8TNOH6rQb0yjqhV+NldW5ir1Tk66XNwPMEzY2vR3ffg2Z2UWgG+aNHUFsofQkYe5O+OHme5NsVP73AYGTSoXR2jsVSgMxtwe3eDgU8N8H898Wmen7+PevRuGrKXqrGHv3phkVUbR7mn5xLO4hFS0iIWzPDBnVmKBZ+/ffownZkeFq/VOf2Kix4o0psQ9Pb0gI7img0UJhQcQGMbK88ZNEJB3IxCRZFL9IKvSGTSIDTRRAoCCXUbW0hsqQAJSkJVgtTYkSxuyyWKwmw1QUGH5UN3lkYrRrG6zPhMlSuVl5mczEK+i9VmkY8/lOLeLTVSahwSBhRMSG7l+Jku/v5QgkLqbjyrk6iaJLbwFPeumeXX3x9jjX0FszRBTEhKAfiRXi7WRvjMEcnXrmxgIXELLZUDz6HedCBqYRoGcbVIyj3JSPwCd61b4OE9MVLmLPWFS4wt1UhFYiR6OylbYLXAx0WqduhTiQYiCpEY+ApsQ5DOpXC8JewIGNKkWq0SiQVI1aDuVDCkSTSSxHGqjE9Ofevdj+x4d7Goqk88vv8zLUUhmWVtvsv62L13bxWjGweIGtb7nnxm4vealaX/LZFMIDDxdcD1afOEBiFWujSuvD7EDaElLcAzYiw7mkbAHxaqwT2r+iV+0AARwTAkOmg/96+LxWPt84Jp0NPbgwogl8uRyWQoFkpMTc0ghKDZbBJLpFi3dh3r1q5rT2UMTE3NsGN0FMdxcF2ffGeOVCpFKpnE813cVhPLaAe/Wq0m2VyGl44cplaucMstt9LT18/FS1c4eeoUI+vX8sB976KwPE+5sojXMiFocObUBN09CTKZDtas7seyDQ699CLxeJJiqUQmk8GM2HTkO7g8dpkjr5wtlZZ4qG/VGqRFq9rUTBy/6M8tuo/EaZHqyF/qTMtfA/ClooXCEw0Cw2h3yrux0eUNYSy1ctp8u0kEpV6ZPfV7v0285frhzVM8yh/V+G8zzvWw2fXw2/Vl32qM72f73rjcq4/9Psf/Xq4vJ99muTeG5278+w8y+ePKWe4tx/6+lhevP3Zvu336B1/vdfItQos/ru1/2/p/kPF/yO38Ad0H/BvgA2/xt98F/t0PveZQKBQKhUKhUCgU+gGEAbVQKBQKhUKhUCgUCoVCP3ae74EN2azoTafSAAghUUqjhWLDhg1866kn+fo3nuFd9+1FSgM/CDAtqFRKuJ6LISFQGtfziEQivHz0JENDGfr7h5iemiKVTtPb20ehcBnXaZFOp9FaEQQBhpTtbm3KRwUSLcVbXF02Xz/bqG53U9IrwTFDxjAsCz8w8f0mgXZBmgilX5s69PqiN4RdpBAEN0QclFBUGjVKTlBJ5jqeDMwsnraQemX6UKERUqG1j5YB6ABWZiEUK/+aKkDqJkq7WOjMqoHIv121upNytcjRE5dbX3mcOx98cORoSzvYsQaf+/wSH/nJ5V+4+57+d3/la9O/MpJUf66UjcAEFNo3cV2fmGVQb7E6nWmPFfiKSrmBDiBiC5TvYBntC+VNbIra5lrN4fbeu1HVSWRtGuks4U3upyce54HNg2zavJnhCwHfOrGfq0sJVvVvo+Bb1P0YLZlEsZqIleYfX36K1vwkn7itjx3DfejGFTxniV7ZoLOnzr/7ua38yeNzPHPhMNVgN5nudRQre/nzL55g6KeH2dLlEHXnaNXnycYNfua+3Zw7dY5EusIj77mfnUNFstYlkqIEPqAUduDQ/ngstpJquj7lrEYjEXqlPRjt6SzbB0C17xOyfdPytZSDWLlJiUYiNZjKB9UC5a88OSTxWAwrHiefd+hVw/x2Zi3fOnCRgY4WH9+3DX/5GI61iCHA6tjG2Zk1/Pu/Pcdc/mcQ8Y1YrfPoxed4ZEeTn7snxRr7OEnnGoZQiFQvmf7VHJ3L8xffqPFCYYTp+F48MQDaxBR1pFwm6ddI6QJZNcGe4Rrv22mwo7tBbf5Zmh6IACJ2J0FimHnRRyOxhJWqrQRN21ENXwdE4xAoqNd8DNOg5S2T6wSlGIpFs9eyiU6mpyoI6QJNQFJrljl98vKvfvK/2/LucmWGLz6x+Jm9tw39YsMz8QOH/ftn/ihqHT/40H2DkZH+JEfSS79TLDT+yBBeBSSGEO3jptvH4HpI6K1owDejGDGLpjK+2fBk1dUqZUrQUoMK3rDsm6NGQghc1yVix+jMdbJ+/UYKy0XcwMcOAvygHZhTBGgt6O7uRmBi2xZCmBBoXNfB83yCQCEIMAyBHzhoXBYWlpmdWmDXru1Eo1Hyq/roW7WK06fH6erKobVPy22Rzf5/7L13lFzXYeb5u/eFyl3VudEAGo0cicgAUMxBJC1ShIMsW7Itci17x8ezHu0c++yc4/GaMxp7js941/LYM57d9Sxpe1cr27JNSRQpiQkUE0iCJCJBAA2gAXRGx8r1wr37x6vqhA4ACVCk+X48ha56ddN7797XIO53vq+exvp2shNnsG3YsWMHa9etpOvUcX7wvTfINMDaNWvJFrNUKhUujhS4OHKEWEySL3Lyljs+c9qpCKyYmX91/+H9nuJX12/edKZnLIsWMlgCQuEZCt/wcE0ncIoUVygwu8rIee7ttehndlTs9F8TU157V9juVer/g6LF3KI3NavMfKhZ72s67uljXbD+LEHWYtfjQwixLhHBwbU7/8vlkv711Fgvq/8FvtNiZpuzyABPMLcwrcbvA+PANxYo83Glk0B8lwGeBLo/RDuPAduBbcBLBNfjyQ83vJCQjy2dXL218zWCtXM7cIjgmfNJfJ6ETNFJ+EwMCQkJCbmGhAK1kJCQkJCQkJCQkJCQkJCQa048YvPEX/5TZNMqucYwzUlBlxKBFKhcrtDa2srFkfMcOvwuUho0Ny9h/fomSsUKF3p6qG9Ik0ol0B4cO/4+QsJtt93O2NgonuNjYNCxdDnvHekiOzZGe/sStBIUnRJGxICqi5rAQ+ggTlNVwzdBzogZVTU12HQEgBk4jolAb6SUE1StFpnaGJ9Wd1a7WoAvJa+/0/firfd/2R8tKnxhA6rqngZSKHxchNaTm881ZxhDB5vkhgalFIZgU7o5JVzbZXhknLP9HPnpL9/8dl+/CxGXN94++Ns7d/Gr5YLPrh3NvPxi7/1Rjz9XKorv2ygBcasJpUvUxSAa4aHG1gSermDIGKMXixgOpC2NWx4nGtd4no82k4xh8E5Wc+ZHZfZs3srupiTx3FFEsUiFIrnKGVJ1Fb64c5StLTFeORtl36njiNhupNlJFhPHN+mvJGmpu4fvD3bS9aND/PoDo9y4vJWUUQSdp5Ltpa3O4nd/bgvtPzzM3+wfQXh3YlmruTCc43//61f4g19bzRJnkFgqysTQCP0D3+e3HlhJc6vBklQeWe7HyQ7iIzGjGRA2GhNPmCgRRUiBISpIvEDMiIkyotW7WcZAIWr3VSq0cEH7aCHxasZ7AoSWSGWCNpF+NNCymQZoLxDG+Q5FXcQXkigJGmWBX7i+l1uXupSyDmNHv0vjCg+sOH6qnvdGlvL1v4fR5v+RPB1EJvpYYb/E7bt7ePTuFMvM0+j+c2gcRBxGiPJ6z2r++B+ynMl+Frd+O64qg/CwfUirLA3yFA3+W9y67CL3ba9naUpiuQMwfo4620TETLRsZqzczrnsGr75PUV+ZBO/fEMXMdPCkWV8LfCVTSwGruswkS0jzSjF7DgNDYJIRD+Eb750ccAFvyFYT0YRhIMyysQz3FffnODge+9x/R75qy+8cr5r9y0r/9gkwr0PLHt7pK/nyOD5C9e3NLfSkrHEkby72ci4r7suGCIKGnQ1FneheEUlIFv2SUZj3HrXA/5z//TUC+vX1z3cmDIQ0qJSqRCx7JnrtrpmDQN8pdAClJaUHBfbijI4PEJDfT2GZZErFKlUXNAyKFdVkxhSYEgbKQXa1/i+RKkg4VgIETgU+kFM8NjIRUolaG1qImZHGOsfYNt11zHY38/hdw9zy+2foS6Voehkef/kSbq6urGiNr39fXSf76KYz7Fn9wbOnj/Lc889x/brt5NKJ9m6dR35UoGG+gYwLmw48O7BuvUbdmQxIz/atm3ndzwNZVfg46EAIYN54hkOvuHhi8AoEOYXAEoN/iKCHblA/bmYS6wzXxdXpf/a+mXKiQ+CuTO73lxubbPbn3P8H7D/hdqc3f5sJ7Xp1OrPFjvpmqh2jrJzndP0fuYb15XUD768tI252rsc5hWqXqPzDw7O/Ljg9Z9V/kqv32xqc7E2pmnlMgQRntvmrjmDvXyyBCWdBCKY26cde4xAKPPEFbb1GIFIbzq3V18/TSjICPnnRYZgrX9l2rE/AR7lytfO16p1p7Nt2rFP0jMlZIpvAP9q1rHaM/FOwmjokJCQkJCrQChQCwkJCQkJCQkJCQkJCQkJuea4ngdwfUOmLlVfl8Z38oBEY6KAl155nljU5vY7bqZUyjM4cJH+vh6KRZ/6xiZOnzlNp+qkqakJ13PpudDHypWridgx0HkikQhKeRimSUNjEtf1KOWLRGNRQKF9F2EYaC3xlcCsiuQkOhCrzSUsm0aw6Vu1L8MCKZGmBk+ifBXEDEoxue8sEEEs6CxMKahoRT5folBiX11TglJFofARaMAH4aK0g67lFSqoJZDWhGpWYPIFaAQYpfI4lUoDRkQTT9D63POv3VDxubBj99qBeJybd25rNVevaODlfQcZ6ecvlzdGkSqKwsNAoQsVKoVh/vCPD8V+8Rf5F3UZE619BHEmxkB6ELNAe2UQGt8FEY2S0xbdecHEhXYOjyh6Vqe4d9MttGfK6EoPvt+Df7GbqOhmR3o5K2+6ju2r6/juW29yOt/DsNHBuFqCiHRQpJW8biRbiDL81Pf4pVsbeOi6OlqtXhpklmy+l6Q3zldu20E8U+HvX/0RY95WiDTw/kgj//2pLn7j1ghjR85g2rCirYnmNQ5u4QiW4+OWy5jawKxrBjcCmCgkvjCnCUQC0aIWPkHQKjPmqalNBB5ohRYKbQg8dFV4GEgFhA4ETUJJpAra9KTE0CZSApYgZkuEYUHJQrsFvIvnWBnViESaPqPM8HCB3BA0r1nJt54+xYH+DciGdur8burc13jksy4/tTNB2jmMyvVhmiATS7no1HPg4jL+41PDDCc+x1hpHflRCztTJEoPDd4ojf5ZtrePcNs6xc3LNc3yOKJYouSUKAqNE1mCTK6jL5vhtS6XfcdKnHf2EFExSt4gTmkMQ7roqpBPihiOcsgWfRARKg60tyVYviT/G//tz57/vX/1r3++1DeQBRlF6ygaB0+B6/OXL7zw1ufue+Bm+i/mzcPHD+8xjBzPPTe8JB5l2bZ1tNY3JFHKoy5p41dcQ1aXiGGWARutCYSA09aYmsNNyBCaSCSGk7XJO+yr+PJhaVpYGHhOKXg2SKM6CeTkc0BgolTgkGYaFoZh4zguqVQ9+aKDli6mYYI2AlGjBikFpmmjtaZQLCB8gWGaSCkxTBOtBdr38XwPIQQGAtf1qE+D47jYtiI7kSeZhB3bd/Hya69z+nQ3123fguX7nDxxmGg8SSqdZHRsjLWrVnLd3RsARaY+w3Mv7KdQfpVd1+9g0+b1xGNxstksQ8P5usPHzv7W4ET/f1i1cX3JMyGbzZPMNOKPeiipQDsgHXzpoEQgyDS0h5TZYO7Ovs7BowmDwH1tLmGN1HOLy+ZzRVNidnk1Z/kZ/QsQyA/Rv5qj32lOWXrmyU83zJyr/Ss539r5Bf3X5EZysn+lbSAFOjqvk5bUU1Ne6EVc3mY7iWk1VV6oqkBOTi9aLTfHseqB2RGbM7uqOk7q6cemmKxaa3+uc5we6TrH97P7/CjPX9TOLxhd9c85/h4xaw5N9b/Y9ZvrQ7U3AWhz8pn3AcVpELjkfGxRSk2KegnGug9IzyqWBh4HDlZfl8MTzBTqzCZ0DAr5xDNt/cy3diBYO91cvvjoCRZeO18jFKh9EnmChe/rYwTOeyEhISEhIR+KUKAWEhISEhISEhISEhISEhJyzTn0ztvUpfiZ9sZG8BzwfUoVn6JvsO/V52lsMLh+1yasiMCKpGhpa8N1NK4jMI0o4+PjvPDij8nm86xc2YESkpaWNsazRWw7SiIWpVzKUyo7lAp5GtJ1SDxGRwepr2/A8VwC8VcgRtJaIoQxh9vKTDHE7M3wyY1nCQZxkDZCg9QyEJtIjdAK368wfatcKJ9icZx0RhERJn3n+xA+Px6+eAxhN4AsVot6aBxq0iiM4PVLX/o8hWyOdLoet1zim998Rtal+EJTE59LpdhD2cMrlGhujhOPsXzTBt5sX1rvDYycOrWiFd7ZP+gffWvQPXaUf7Fnz5ono7FVKGkTSThU8sPYzgTxqMPtN/OdtevseGNDjIrrMjpW5Fw3A+k4+agt1xgRgeN6+D5Yhk25YlDWbRSsbYx4GR5/r4/vHTnNV+5ZyqbMeTal65H5rkBnVykQdU6wtKmFu76QZv/pMZ58+33e7VvLsIjhROsQdWlGnA2UdQP/8ZmX6M0N8T/c2UqHdZqEd4q6WJyIf4av3FRgZWuSv/jhGKdG24ikN/DtV7tYm+jjga1pmlNNSKnQE0OY0sBXaQy7BcsmEBPJ6r2UAkNotHSD+6uDiNUguhOkcKYES9pGU50zQlWTPiVCOBg4KOHVpgYgkUKjzQpSg6F9aqmUSIEWFr6nMKWPME0s0QzCAaNI27I6sn4dKmfz3LO9vHcsTiSRouIeYGfTc3zlfoudy8eoVwOI8hCGCZGWZob9DXz70Er+2zM5LsTWU9b1YApiaoI0F2nWh7i+5V0e2Gpw05oUttePk7tA3hkj6mmkYSDSqxk1ruOZd+o5NNjCexejjMtmrOaVyHOnyPsenl9BWg5CgCEk0WiMunT21Jkzbmps1GjLxFMoXG65ifjIME9a6tx9qbhNXeMKyk4UqXxMFSUdb37yhz868Gh27LW/sJNYTY1sLOeH3/uZz8u1veeU2dEB0fo6shNFhkcKbN/K4/kir/X183RDhr//+S/sUU7JRhg233nq+0BVrqnN6v0KfipMKhNjVHzB0OA4uTIvd/eMsmrZeioDQxjKRcSikxoaXbVUktJGEyURD1z0tNZ4ysWOJFBKYhmxSWFI1RctECspge8Ec8EyZLCGtUbjIrXC8108zwMUphRI28aSEQwZwTAioCXReIp0phErkqK1rZ1TXedYu2Ezh490g0hz6623YlgRYhELU4LvOVQqJdLpDJ9/6E7eenM/xw6+y7muOGs2rCGZSrFyVRsrLgz9/kv7T//5rfesGMcFQ3oM5ybwjTy+hECWqSYfgKbvgy5w/fWtSGWjpkUXTxcSCb2gJOjKHcVmFJy77enVBVwiALqy/uWs85ldf0pENlec7EJ1F6Xa9nzVfN3A44+/h68Cl7+53Nsuq5tLx3wHUy0eVIJxmPrdp7UO3AOVRmvQGnx//nFOCuQuczw1Zo9/sQjVeQVuH7Kfaz3+a9W/BuLxQIivpi7OY1y+OA3mEKwEkegKrTW2baOUmvz8USCEQEo5+aqyXQixb67xTuMbXJ6A4gkWEGJUz3+F1nq7bdsHr/T8p4+/Jq6rvf+Q3DHtfTfzRDNOv3+19x/l/Qv5yTLH+ukE9gkhFlo7T1TLLcZjLCxiQmu9Qil1h9Z637V+fsTj8ave5qdp/SSTydrbJ1jkvhK4qHUy7blzFZ5pISEhISGfQkKBWkhISEhISEhISEhISEhIyDXnxMkTcvf6pb+6etVaTNMgm80yMlpg3/5jZ4eGGd38YNsuy/bI5cZwXU0yoTCMCIYRQxiS5cuX81MPfJanf/gjHMehob4F1wMpTFzXoVzKo7wyyvMRCnxVoS4dp/9iD9LQxBJxUAJpBAISrR2U0hgiAmg0PuAjhDFj3JK5Npyr4iUkGHZQT0lMaWAIDXh4Xmlyp1nh4+tK1YFIkp0ocKarMvAzeze9kzPKeDoLFKtxhR6q5rw2zT1teDgQWvX1dnHgjcO/sWd39LebG41VS9tj1GfqeObpM/SdvUA0Vs/OzXDoEMTlmPkz92/ZaBoWp46dpevUuLdtC3tfe6VrxfHjXX/z27/zU2cnJvpIRTTPP31YJiJ88+4HubezI43vu9hWjN7eHgYG+bPWzTxkRdQa0zJwKy4mUPIgV0lSNtooiSbGjXbGjXZGVAd/9PQBbltm8tnOVm5a2UzUGiMmx0iqLEbxGBPZLHvaOln9uW281l3he2+8Snf5PH1ZG8dspeitQjYt4VtH/gFHjvDl7Z1sbqwj3/ceUWuUqN3PZ5avwPz8Lr75/Hm6+8/z5S/eyW1bz9DaOIx7cQQhPJR0QRgobKSO4xNspvh4zLzI0+7yPEIXjYnGQBHExQohEAiENkFIpCrPUUvNiAkMzPoEyhcEzmwSISQQCeaVKOJLhedKli9bwW0yRsWCc8+/wo4ty/n1BxJsypzAudiNsiEVS6NiyzlTauZvnq/wt29qhqJ3ULTjREyfenmCpOyhRfbxhVsT3L2+iYx3DLt4EeE5FMouWceipWk1Q+UM+88m+eGJCkfGGhhUq5lQDWgjiSVs0jGbiYqLFhKpQfoEjkO2Jl7HcPcxnjh1cuAPbtyxDNwhmupN7r/b/uw/fveNb/WP8aUHHtqthPSJJ2z+8x+/tHLTBn75us3mjqVtGVHX6Buf39yx0Y5IDr37LroJrltfRy5X4MyZCYQPD96/Zo2Qes257gu/cq7b+YNvPv7S//aFL+z6C6ETk7GLQSSumnEPDQUxFIWxEZLJBHfft/vtkdHjA8Mj+baMEChN1e1QMCUjqUb+SgONGdw/rTGknFehEwh7gg3MwJ1RBam9QqBEMMeU9vB9F9erIIRGCgNDmCjlVTdAvWC+CMnw8DB2LM7Spctxlc+rr77J+Fiee+67n3R9BtdVVColyjoQuoFE6uDe7H34YY4ePciZM6fY/+rbRJMxEplWmtuWmJu2Df5/HvYDtdkPHko6gYNabVVUn4OGAnBAeIHeb1IBI6t1q4Jeqs5T84jJvHnc1ea/jvMz3Tltep2FhFqX9j+rtJaT7c3dTrCOa78dzGmCPDVtTNPHc7VQVWHapFPWJSOb311uxpim3j4GfA09JfJRggl0EI9YO7NgY16h0NX/as9JfYmYanr3C5367PK1p+9sruTyaS4Vdc1VfyHh20cx/qvZ/6VlZ8zaDJfGsy3Gd66w/EdKTRQihHiChcVpEAgo7mBhJ6i9LC7EqJG5zHLXmkcIxHezz//fEazpkJA5qa6fJxYRpwGsIJhnTyxQ5g4ujcSdj5pjW8jHn0e4/GdiJ/MIY0NCQkJCQi6XUKAWEhISEhISEhISEhISEhJyzXEd58+TdZn0md5+3uo7T7mYP332nPutvn6+vmkrf5pOp3e5yqdUzGHKKCiNEBoMUJ6Pp3yWr1vP/QKeff45BgcU8XiS9Rs2MTrch6pUMC2FjBgkM5KxiRHyxVESKZuKkyMWN9DCQGiNUj5aGUipUfggDaQ0g6i+qnBJTI8bq72Ytg1c/d5AoKWBIQUCH7QKRBo1xx18hPLxHQfLMPFdzeBQDmHytOP6GLZRFbs5VaFS1aOt6lhTI52u59t/+0wmneHJu+5N337dplYMihjSx9CKbRvivHOoyIYNHp3tdVDJ8v4xOPjaUZYsSbOms4HrtrRGPM/bu/umwt7uM97/euztpx/vOsV/amlh+aYt/NmttzVujNUpDNNHyyjnzo/x+n7+LpHmzxL1/F4sReDWpMCwBbmKYtRJ40aW4UrAcNBSktcN+I2f4cWJMY6+Mcim06M8cEM7a9KnWRP3EeVhtG1QmuimtW6MX9y2lge3d/L/PPc63zmepN+7iXF9IyO5NIWmh/izN1/gzaMH+KNf2cSuJRIqx6kURqiTQ9zXfp7Elm4qOxPcsaeeSLaH4sAgwo7iGQpRFRQZWhDc6tp9C/5JLBDlGMFcY5qwQ9ciHmuxrhKERung/gghJ/VMQbCrVZ0fVTckNVOOoOWUMCeIRKwdlGhDooVASY0y0gjDIZOEUu4sDbEoX7x7OU3pIZKZPOsbNJSyNMbiJFKtIFt4b6idP3rG4LXhlYw2rcM3GzDyExhj77Ku6Qj3bnG5/7oGGswTWGoEyiPgFDCNBJnMEnyxmhcGV/Gj41Fe6U4xElnJqDDBqgM/BVriCgcjFSHngbYyGB5AGW1qEAViKXZYce478I7avrqj/IXOjuUU8+dZv66dL/9C4Ysvv9q/9a0X9/9PjsOFzlX8zm/9ZuzRjo56Y2XHKiqVEmifkcEBzpweYOgi7NkDdTFFISfoOwVbr4P65CC+57Nzc4obt9avvn7jyH997odvf7F/mL1WOnB/CkRqMyMFJYqIZWIKTdkps6S9mQOv7H+mp3fw0dTSBpQqB/etKiIL5owOXPKERmsXhFVtLrjDU3KQmY6LNZGWqEpXAoM1VXVm89EqEKf5voM0QGMH8ljhTr1wkZag7JRJRpKUnALHjw/S0hph78/uJZ6sw3V9EAqFnBYLOTWGM6dOsmxJOx3L2jjT3UP3+TGefbr7bT/KvxHxjE7XN1QnpgNGGamzVefG6hyddNFicl2I6SKweRwmZ9eH4Bkq9UyBzmICrgVdwRaJe7wq/S/wvawqosTMSMXF6y3c5aJjqZ3rXA5qSpAh2GDeSyDQqfES1ZjCav3HmFtckFazIt60CPqcXEp6xrKCWe8Xcz6Ts8rPrr8QC7U9V7tzsViZazn+a9V/ulujLAAAIABJREFUrd6suh8krvOTEMW3nct3hdvLwsKYj9P5PlJ9bWdKfHaIQCRUG+degvU5F79PEGkaRpGGzMd2Zv5eWIg7WFig9tgV9Nt9BWVDfrI8dgVlx6/VIEJCQkJCPj2EArWQkJCQkJCQkJCQkJCQkJBri4Z4LP7jrq6uQ8cKlaxX5v2t29rebVmWY9nKGCMjw7c5roNbDrZZU3V1GFUHH9/3AY3juoz09dG+rIMvf/mXefzxv+Ltd07S2NBIc0uaSDKBbWni0SjNrS288+4A3efPs23bVrrPnaXilIhGo4iqC1K5UgJDEyiMDLS0MIQFUlbdg6pbviKI71SAFnNJDFQQ3YieFKdp7QIKhRs4InllDDxMYeJ5krEJRe8gj6/ZGWdivIQvXAQahD95vab/FMC3v/WMsXw5r9/z2fYNS9sglztJ1IK4bYOR5sZbtpIr7Oe5H+S4/3ONbFi7ghVLfQ6+28PZrgkG+yeQBixZAq4DK5e1GrosvtqU1l9tXyrYdeNKXDWBFBCP13Pq9DBvvl4Y2Ll12RdffLFnfSxJVNou0gtOUytBxVU4FUVEWli+GcSnIkHYlFSckm5iXC9nsP8CB//xJe7cFOPBbeu4fuVa3PETZOLjWIyhRw+wJH2KX7tnNTdd38GT+7t54a0hxiPX0T/RSDS1leN5zR/+/Vn+9Wdb2bMiiiXOMDF4mokLr/GZ1fXUtTfg5Q9QyeewbQslQGmJIALYzCcPERiBu8QlGYDTys9yVJvupDSjvDardj7TJAPTxTSAgUTrmnhxSgTpmiqYX8JGuwr8PMKtYOkC3sQoD9+4lLMXTnH6nQk2rWvBinZQ1qvYd9Tgr18qc1zfwZhowiePzp2hxe3noZttfnpHHRvrLpAqncIvjJAra5RMEW3czmCxjkMXTPafS/HUkTL55C4Kqa2M6QiICVAe+IGrn+GUiZuSYkWgZBqtywRxtIHjV12aqO/Svn5H5Oef/M7QwM98PtLa2NiBUi5NGcHdt7Vt3L6l8NzhQzma2mBFuwn+CK+/2kelAqVCEB/Y2gq33JygqSmKIQ2++w9DdK6AnZsbKBRHkTbkc0UKpRE2dK4geje3v/rW2GtnhrnOF/hVRdjMO6OhnJ8gFU/hm4qJ7Agjozw+NJp7dENHG54AQ7jMTCkKxKIaF4VAVmNeZwpBVDXaSE3WqFqtgfCrIimFQKGVi6cU+B4ID6UdhDYIBLEmWii0AL/q9CWkpKG5ETsW4/DR96g48ODDe0k3N5MdGSefLxI1o1iWiSkiQfteNWhUCOLxOPlCFtOUdHR0kK7rYHj8sGNmlj2XcwW69k/CWl0yv+diKvaRyXmtxDS/uctQ6swu84EFW9Wf053DLqetS/q/Qpez6eWnC+BqguJ5611ZNwsyl4ipKph8krkFCLcDtyu4k0As8PtzjWlau99gHoGTmuO9nOO7+Zgu7Jxd/8MwUzA6f5npXGms6Ox+rnT8V7v/ReodvKxBTfEonwyXo71XUHYhkd4dBE5Rl8ME1/bafIO53e62AX9Sff8ECwuGamU6CYUjIXNzxxWU7VzguysRusEn47kSEjxbL/eZeI4r/x0TEhISEhJyCaFALSQkJCQkJCQkJCQkJCQk5Jqzce26b0XEEJN+H/E6LN/m+NHzifUrY+2pZAookU6n0Vrja4UhwRCAMHBdFyEMxsZGEULw1a/+Kq+//gpvH3qLeDzCju2bsCzIWz7LV6wjW6jw+v4RIrEu6uqS+J5DsZhHShODMqaMIrQLWqKEj0ZRKVcwrAimYYAwgwjHqnZJMi3dDhnECE6nKk5TvovnVwIRiu/g+w7arxDRCq+iKZPgQl/pxF33bn6loiTJWBIl5Ay3tBqi6vwjBBgG//aWW5Zt6FhqoPzz2AY0ZCAqI2Tzefr6DrH7llU4Pz7Dq6+MsGNnlPp0jO072vB9lxMnRjBNGBgAtwTKG6SpGXbsrKOxKYNSHqaXwLTjnDo6wIv7Jg4LkwciciXonnuWtNSjlYPvVpCAryL4jsIfP4/Tn6B+yTYMXU9F+JS0E+iapKKsI5TdNnT9L/LD3l6OD/fxmRWj/OyOGKnoaSxhkC8PI4p5nPJhrksOc+ND23h9xTDPHLrAP52ro2TswIzv4K2RZn7n7w/x6D0dPLjRpm/4FC1tMYyIjTeaAyRWNIMGLDTC1whtg7ZRRFDSqHpaMbnTL0RwL4WYEo5dKtiZ+hy43AWOZzVXoeD7IKpzSuNUjSSTwRGtdSBqEWIyIE+g0ELhCQ9leIHbnlYIaWB6CSJ2HHAASSmfo72xEYsyhw4NsW3P9Xz37Rh//MMMw+YutExC4QxtxjvcuqnET+2MsWt5hfb4CM74WXxdQMYtmqw6CpF1/OBsAy+fa2X/mTZ6i8sQ7cspeDEKZQ9dyYPvQswORGpOnhbp01DxmXDKdPeNsbpVYwiNFhGEjmGqEk5B3R21Vp7wvPd3Pvf8hWduu3Xt1pb6OBHDp63JpakJlnUIhgY02bEcY2MgJCTjsHa9QSwepbGhiXLJo3+wTG/vEJ0b4IbtaUZGRokbEE9AotUiO+xSzF6gtameXTsaNp5/cfR3teTfu+7U5RciUHtJoYkbBrqSxzQkSiruvW/3y13vvXmy6Ol1tmXjaRcThZCaqfRGjdYmWvsIEbigCRlIE4UOsnd11XmtFu8phQYU+fxE9bMI5pcZfK90IF6LxczAac2AXKFAtlAklqojXpfB9TS2GWVgeJRDh16mVFE8+tWHqW9qoZDNUSyWiUaj4AXi2Rm5f1oGjo4YCGFRcQrkigUikQYSdXrTwZMH450bNhbd2vNLOCDLoPxZ2Zu1Ocrk/J3+GeYXbM1GaJBzOJ0tFvU5nUv0o8wU61xx//rD9z+937nOb65yHwRRFQMuIGLarhYXDTzBNLHAAm1tIxAhzLkBrcRMZ8/LEVbNqL/I5w/Khx3HB613tdq5yvXGCSI7H76Msn/F4uKnjwudV6mdO66g7L6r1Od8LBbF+hjBeS8WzZgmEJk88aFHFPLPkasVU3vHFZR9iVAw+Unhjisou+8ajSEkJCQk5FNGKFALCQkJCQkJCQkJCQkJCQn5aNAST5ooIcl7EhcbIVlmWJG01BIhBHKWmZUQoupSJAKns6rNUblcYvfu3axbt46zZ09z/ORZPMfDdcv4boUVKzqpaxjj2RcucP9960gnbAQehhQYpgFao/zAvcgQAnSgbPEcH9+QSGlhmgZSSgQmGjOIiauObabgYEqc5ntltKqgcNHaR+GC9tG+h+8Ijp4+T08/v7Nss42uCptkNTpP1TK8pjuoaQlCiU3reTSVLDM2PkwqBq3NIH2YGMsxNgE5BVmnTDzdTu9QH995qpc1a+CGGzcRjcKO6zswJSCL+I6L8uzgfPQ4jpsjO1FkcKDC+fPw41f4t597sOMPEG0USyaJKEulluC7aA8kAsusIzc4wPpMmi0bG3nh3ZcZKbWSlTZevJ5xHaWgouh4AzLZwaiOkvWWkM31MHToCO+/d5o7t9Sx67oldLQUkeo8cdFHxDlPojDG7R1tbFm9md2jDXxz3yFO9vRQJsWIbOJPv/UjzLty/MJtm4llDCjloajRmHjSCq5pNZtOawNfmAiMauxibV5V/0lMaoQ2p653cHCOuWvUKs4xsQO3LbScdu9qb8TUn0IShIZW40S1P+W2pqs3X0ukMDAMA609hJKgHUzpIYRkaX0z8WiC7z97gP/jmQJex78hFW1Ajh3gxvUT3LUpzl1bIqT940QrvTiFMRzfoGK0YafWcbLH4gfvVvjuGTgnl3NR7EQlVmD4BvhlpDFOJFohqvJEdBZVGaA57tJIjt3rHezBBPlyEd/wqLl/SW2SSaRpTI0trZQFG7ds77PE+Lb/+7+f+t0btvIfVq6C+hZI1Qva2tO0L09QKaTIZj3iqRie7yItTTQRYXgky6GDvXSdAsOAm25uZDgriLogDYhGBbrokogbFJSPVynQumQJdmT00fFxvh6JoAPbQzEV8anB1AqBV0tlxXVNLlxQv338VPd313ZmiEofIV1MYyqLVQgToype9X0HKewg7VdM+edNxvHiIrQKIoNRIDyEVtVpoFCeQk2KwhTSsLEjFheHhjnwznGyWbhx940cPHSSQqFMLpcDYPnyFdxz74Okm5tx80WKxeqFQCKlRGmN8EEocemsnYwaVoEQTThpBMsQzsngRBQoB4Q3GUl8JdSMIz8IH0aw9ZOoPz3OU1QjPudqbz4h2zXmcsQHK4CvfJD2hBCTAsWQTwxPsLhA7RDwtcUa+knfe6UUpmnC1RO7XIlY50khRNXJ94MxbfyzuZwo1jSLi9hqdM51MFy/n27EnH9n/cBc0dqp9f9h1s81pBaLXTuncYLn5oznzKdk/VxJLHQYJRwSEhISclUIBWohISEhISEhISEhISEhISEfCVpIXGHjS4lbAekLtElHNBYFZsbFyap7WU2zNflt1d1qbHSCTCbDkuUrWbJ+M2O9Pbiuh+M6eK5LIplk49Y97N//GqdOD7BjSysxW1EqFlG+JBpNIrAQMnAvm9zEEQqtQGkXX0u0YSCkjZCJwI2pqkyoxTPWQv987eJ7DngOEh8pFa6uBCW1AuWjPMXoWOnNz9x60/ccwBOyGh2opgQPMyIKg9hIiZOMJ2lNZ1ycMlgSLGHguIK4lSK6pJVz74/q7/1j3/9ZHOfP43GWui43vHeG5iMn3lve3hb76bVrlmJHiiSSBbITE/iOhVvSlPIeXiVwh7PtwKEKSAmlKVUmQCkak6wQWoJvVcU5AtNMUBk+w7a6LFs3neSO9hLv91Q42mdzrrSEU8VljFqryMkojpVAaY2nTfJ+goraiIps590DJ2g8eZ4H93j83A1pOuISuzjEyGAOHc2RMCb4/MpObm6r57WjA3z/jYu80e2xblWC3de3EIsOUz7fR9S0wYqBYVVjNqPgRdCGphCp4ElF1AVbVe9ZTfBILbZVV4WAcpr+bJbcZ9E9vtnyoFkCNVGTRk3dYFmdPaaOIH0duO5JB4kH0kFpgRRB5Kypymi3hNRJWuqbuW33Gl5673XOVV4lZR/gSw8rti0do7PBg0IfTm4MLBfiBr61lGHvBl58O80LbzVwaKCZSuNqxsx6lLCgMoHvRomiiNkl0sYgavB11iT72dmZZU1riXWrM7TUR9i/b4KR0QJqXQSpwdAaoTUNyQSJ+NgKw1QoXSZfHkNDKp2CchneegfiaU2ybpxodBw7YmFH0gzlsxh2kp7ecUZG85w46fzTuQtciMa42NzGW3/9dyO9jTH+5Zceav/15nZb5Ioj2BEwTI2dEnjCx3Nc4gnasudJtLSQN6SB5828G4YOojal8HClpJj3ueOe3d/rOr7/zSVL4jeaEYVUAqkcBBHMqk7N1x5CG4gZoa5qUpCktMBXHoIyvnYQykNrjRQ+Go3UVWGaqK3x4HnR23eOxsZGsDyS6RhWNM13n3qT9vZG1q/fwIoVCZYsWUJzc2PQT0VTKPlIIhiWXbVznO3iKINnZtXNUVTd3KaEakAgVDo5lyBthiParPl+pdvL09tSH2B//ONUv9bGjFhPPXX8g3Cl8aIfMZMb9J+Szfl/juy7jDKPcAWir5/EPNBaT/7dTAhxJQK17qvRvxBiX+28P8j5zxr/7K+vlqtVje7ZB8L1G1Jl/CoL1S6HfdPn30c0D++Y3v8C5R4hiNed7Uz4WLWNgxCun3nY95MeQEhISEjIPw9CgVpISEhISEhISEhISEhISMi1RYAnTISw8YWJ0ia+ozCVhZR02pY9WTTY0JuqqpUGo7q5J0TVhQq0EmhlUMyVcScKIGxiiSRpy8ayLHK5AunmZu6+p5lnnvo7Xn/9FJ3L62hf0k4qnaRSdgEJXhDrJ4WqxjEG7kRaa3wFvnIxpADhBsZMhkQKCbIWBwkaH9+voPwSpnYDgQge0vdBeighIdLAu4dPcqK7+AuN65P4lAO3HRVE9FV9joJjEoQfiNcMrTAU5dw4OXwZTSdjJGIGnmcw2DfB+PAYnpHj5dc89+JFXqyLs7Rc5DdbWmhVaS4ceJPHs7nSI9u3dX2xsZHf7ehgRWsrjA27xC1IRWPE6hWtSzTRqI1hNNHUOvq/vPjChVvHx7nt5j0b/LqkWG9oJzhdAVoYVBxFpQItKY905QBNaYcNDWnu372J0+MWr58Z49jFYxwZOsLFfAbPbMUz6pF2hJJOcGIgiZ25i0H3HOef+zEnuib4/M5l3LpuA8llfcTMMVRxEDX6JssTDfzc9avZtLyBb786ym23bKeztZdi/whxM4HneJimXRWn1V42PhpP+GhmqZVmi8kuifS8FszlylZ10COYQ2gTA2+aGE6ihEQiEaaNVyjj5CewvToakkl+7Wdv4KW3h9j7wB46o28StXsgN8HoxSLR+uWYDSvoqRi802Py7X3DHOttor+0FbNhJ2NOHl9UsCLjmGKMdDlPyh8lbU7QaPdy570xdi3NsD7l4ma7yDlvk2YJKatAPgta+4HMTmmk7xOPJ5CK9XUJySuvHTeiEX781V9vv3lpfZTxsX5WbjQYnsgzPAqFEoxOuMTio5w9r+jpHeouF/nD90/yt1pw+7qNPLJqTWR3z4XKjZbBfxkZ4cUXnut7dGgDdroBzAi0tCdJxBOYSQudj2La5EoFKpJA0Be42QXXVmoVRM5SW2cSKxbDA3qG+YU33j135u49K4mg0cLBMCRC2oF8sCpsU/gI/KrEUIAInlVKB88Pp1KGqkMb1DZjFUp6zBXM11DfTNnxcJWgsWkJZ0+X2LplG3tu3UPrknbyExPYtoFC4jsunu8jtYW0DbTr42s36EMHMbGXbD3XnNNQSDwM7WDgIDUrQIIKnrm6Og+lH528RkF9Y2Z7Ws89hyeZcoebarg2i6vRkDOiSBdo6qOor+aP8Z1LPCaFmnUXa+c7q+B098+FxngFe95Sm1gaEMX52hr3sVGL/zP//0zgmLVigTJ/xax4zykX05BPEIuJuS65z/Oh1NUKYv1gTBN5XdZ4q3Qv8N0TXJ4r2Tmg+8OKVKaL1Gax7zKb+FMCh6OFYnwPMU+8Z7h+P91U7/2+K6iy0Dp7kuB3yGKRsxN8tCKvrxGIy6aPa6J6/Ik5ys8lTqN67DGCuFzgU7N+vsHiMeEQxraGhISEhFxFQoFaSEhISEhISEhISEhISEjINcbEzrRhiSimUEhlEhcpdCVPVp5ZnYzHJ0sKDYYUgctV1XVKCgMtBVpWIxSlIJWpRxgmWgss0w4ECEpQcT0cT2NFYhSzeYSw2PvTv8T7hw5wuut9enoGsG2TZMJmSVsrTc1pfFVGqSylQgHXEZhGnHgsjSFNtKHxlQTpVb2vZDCO6p6tAjQVtCohdAmJwtSKwvgEdsTEk+BF63jt6DCvnC3+ZqI1c/b1g++gqyoIWY2O3HLdFnypcKUKxFUlk4wdI2VUcIq9brHc/2xpLPMl18rz5vGLeA5YRqAH8YXHHXuwb72Zb6EiCGVTKpWYGPdubE7xs+Pj/N5Ejm9eOM0z2SEe1ht47P57r2vSOks6FUMYJWR0gtHRcfJFl6UdGT63V978o2fGX3nu2fcf3rKVaHNbFOQISnkow0LEo5AEMw2xuihOIYf2BhFujhV2mpXbW3FEkmze4/x4hOdPVugaa6J7ooWCsYmSuRSnYuBEmoimH+apYys41D3ADetzPHhDO7ev7SfqeiTjZUqFHMI9T4Mv+ZU9GZa2dGPmhzEidWhtYEYiICRKG1jaQAmNMl2EFERdiZRRDE11LlWd0+SUAEdI8HUgOhKTMpQrUMBMY9JRqSqknC1S0dUESgAMjcBHax8hFFoH8ZAShUYFTlzaR6EwSIBlEm208bXGrgywpdkksXkEdf5vsVdZ5Ib7SUSjZDrWMWpuYF9XnO8djvPy+5Ki7sC1V1O2luEURknZOZLeAJHie6yo62H76otsafdYuzxGfbSCVRkhHYFKNgdekagJlfwEmUSKwkgOoUwQHlLLQPCFT+dyYi89f7ylqZnv3nt/y02x2ATjuT7iqQhNy5bQmI+xdrWHtFLkChF++Oyp4YP7eayQ50kMIrs281srV/L1TD2k6lw2LQehechQEsOV+K7HyDCUPDh/MY9h5snUJ0kmOsiP8+zehza5uaKgLt1MqeBjaLC0g9CKF998C0/qSZGSX3UulAZnz/bwLwcvuH++ZmkSrzKKlVAoI4qUCilAKRcpzSByVWi0lGgd3B/lB3GeWgXi1trt9pSLaSo8VaZUKuApSCXrMQyLXK7EyVOnQZvkimVMM8m6tbvYuv0G7Hicvt5eYrEYXlFVnxEg0cG19hUohVA6EDWi0FoEhmrVOaV8VfXmU0hTYSqPhOmyqrWB4139qxN2E5FkKwqJKYqAx8lTI9PcwCSqOnF1tWFdzfNU82w0T4m65haxLeY0tpij2LWvr2Z9Xqy+XOT7q+eSpnSRvfetQWt7zu894gef/MGBc2DOKzxTgSDpGwRChXfnKfbvCDbngZmOT1LK+WIKASgW5xHPhXxc+cb0Dwvdv5pAQ2v9kboJ1fqa5kD2pBBigsXFMYtxEHgUeHyhQkKIg9PHcaXnP8f45xK6vMTCwpDvEIhsOqvjnuvc/4o5olrD9fvxYTGBUywWu2Z9V+ftQSHEOSHEQuLkGgsJkA4SuI/90yJtHKyd8wddP9OJT/t/xDm4A/iTOY6nCdb4PmYKVh9h4WfIw3Bl62cxPu7rSyn1JIGAfa7rOJ05xYsL3J8Mwf3ZTjCv9s3Vxsf9+oSEhISEXBtCgVpISEhISEhISEhISEhISMg1xxcSKUHowNEnHrPIFypYwr151eplCH8ImLmJJzSBq5khEUIihEBJDVqglMLDR0uJWXX1CgjczzzXRxoGhiGpOJqNN9zFxk03cPZ0F9ncKIP953j/5FlEVxetbQ2sWtlGLGpimxrH8ag4JSJ2DFMaKDRoP9hg8TVSyRmbF1pV0HiBC5twENrHlIGIxMNgaKzM+z1j35d1Df8153rEE3GU7wKgtERj4uoMrpa4eIBJKpWhUsqRtBy09hka5BsvPn/2S/UN0NwKbSuhLhWjLpHG1y4lN4fnu6AVhgAp60HZ+J7AU/Lr5y70f733gnv4+DH+8vWX+fcTQ0d+6fOf79hlm45RqoxgxApE41EMK0Z2Ik9jU5TP3CJ2u2V9IBohLilXIyhBCcHF0RwXi2Ck13MxsgXtnUaoIbQ3inR6MVUvGQtW18VYm0yzZ+s23rmgOHhmiPeHKhztOcmEbqcsMminlVjLLib8As92HeGd04e4d0OZn7t1D8vTY7SkJxg6d4TRfoc1a4rElEY5LmAhzAgIC01VNCgkUoMSCiEElpKIxRzS9FSQ7MIuUdeCqtNV1fFKVoV0QsuqACkYn+9LMA38qmOfKo8RjUi2rpS8f2KYoWGTdOs6JqzVHOuJ8J1XJ3jjgs3xylLS7dfjjQwSEUUS7jFMhklXetneabJrjWZF2mHzMo+kPkfEz6HKBSqOS6kYQVtNOPFlmIk00myiKAbJ+4fxVAopKmhlIJQmEYvgubRl0hy49Zbm5bFIEdMskkrFiEQiDPSex47EUEIy1NPvf//77tvdp/mbqIW89R6eXrHC3trQEKEhk0RKF88rgXAQeEhloZ0kypd4FHDwyFU8+voVRw7mUeo9Rkb5k9VrDSKxesYKURAxBBChiBAOZRlHian4S1W9tr5UmIr/8sKLPQ8k7mr73KatbWQLY0il8AyNZYIhAsc4XyscFTyjaoKkQKTmAlNtgsKyDHL5LKYpaWpZRj5XoKdngKHBUVA29Y1LsCIJNrUto7VtGYlkM4WCw0R2gNbmFnK5HABSB/MZrVHKR/s+Sil85aHxkXiIwGMviBKdhWmYSNNFeWVaGuqI2/2faW1oJFs2A2dHTIIo4SjoKdGmRAbnqGY5hel51sli+86LGZB83OrP+jz9bOcUu806djUjPCWAKAevuQiisB/x4cV5mvgrgk15CDaHV077DMHm/ZMsIEyQ8qN+LoZ8SDoX+O4QV+ZGhlLqJ+YiNMuB7EngK1eh2ScIRBMLOaldFQeoBRzUIBCW7WNuwcxLTK3TboLx7mUqGnSc4Hp0LzaGcP1+upFSorV+Avj9q9DckwRi5oXa6q69+Qgc1B5b5Pu9zBTkPnKlHVTXz3am1t5B/vk5iX2D4BwXer5eyTk/wtxOddP/PhISEhIS8ikmFKiFhISEhISEhISEhISEhIRcYxRSlDF0OYibE5DLdvPWG/tbbtiWuqWQ6yOVCDb1TcPAFDIQoUEQv6lVVRQQiCW01ni+Qvh+VZQRQZoE0X4oAoEPaM/H8zSGNBgbGKC+tZmV27cCHuQ2cnGwl2PvHeL8uX5OHDvHjp2b6VjeQKE4hudkcd0CyBTSiKKrDjtCC7SeQw+hLAQ+QhVw/RJm3KTkCEp+lHePnqV/MP8bRBPYto3yFQIjELwJ8IjiqjYcHa8K1BSjeUVUeETJ0903tCoe5Y9WrYGVazJk6gWFwhimVUIZPrZtExUWSptIbeK7At+pgHIw7AjCNKiLxdi0Lrr1ttu8/3y6qzT8g6c5+389fr585z11iRt2b2R45D0MK4ohE0SjJVy/yKYtnQz2nl1eKlG97oABvlIYVoKuwTp+eHY9/9i1jD3bm+lsGWBN60Vi3lkMpw9fQa5cQggwRw5xU32C2+5McjHr0zsa4+jZNzl4Gs7ml3G6vIWcvQqV3MiwWMf/e+IcL5w+wy/e1MoD1xVR2VOsXRMhnqlnYnCQVKIBaRhgTLnZTcbAAsiaa4msfhS1QjPvW028Vv0p5dwbyUpppBSTP2cIFBfYfJsqNXdMmhYEcYoaBBIhvKrtmjmtfs1tTyKEAoINP9MwIRYhVhfjxGCJxrat/MVTFi8eSpAb306scT12Ci4OHGWp3U2qeILtLZohdbwQAAAgAElEQVS7NjeyrqlMQ3SMaKyEIotXyeJ6JbxCCd8BEWvEi9WTizTRdTFDb/caurtdznQV2Ny5nTI5LJ0FHaw1p1xBaBo3bKBx5SqT0bE88USEWDKO62vyvkfKTNPbXea5Z92yBPFT9/HYxo12YzqZQPseQmoMmUNoD9vyg7UvQXsOWuYxEEjbRxiCiZxiVVua0RUeXd0Fxsf5o7ePHvm1jnX3n9HxTrKVGFpIDJHF1kUquhlLOaj/n733jrLjuu88P/feqnr5vc4BjdAASIIEAwBmiaIIBYsKlkU57Viyj+njPWPPesaWR2flnd21De/s7IyPZ2c5O7Neh9kznPHYXtsaK6xkkUoELTGIQQQzCRJEIzRCo8Prlyvce/ePqoduNLvRAAEiqT48jw9dr8Ktqlv3vX716e9PRICPpQ0yLqdqJRiXf7T/2PGDG7eOId0+TCDj0qA2RDpuPG9yDo21cZnP5PxYkpK+hCACEIa52XkK+T60zrL/9Tn2TbyB57oMD48zPDTG+KZrkX3DoByi2XmCICKTyeAoRavRWCQ4mTi1TBu00QgbJ+7FQmMEtis3ChBR8kjGKiFQ0sXqkJnZacbWb6W3sv99X/vK14Y+cO+PTxnhnCK1LZaqYpkv7nnno8Df6olkl/bysJCGuKqs9g7as5Sl6z2D9u8GdhDfrP8UCxLSbt5e4myC1W/qAxesPFvK+Wf8NK89+E5WeDH6wWK5K3nexfkR1CCWw+7jNCVvF/f/d7L/y7R/KXuIpZBdSVsmkml7WJJyl7y2dNppSa/flC5CiAc4s/KcZ8IuYslopWtnItnmOV0/Z8BOVi9N2bPK6yuStH8Xyx+3A8n0L7/T9V+CdMfEc+0j46ycUPmLLD++paSkpKT8iJEKaikpKSkpKSkpKSkpKSkpKe8yBmUjlIhAx4Jaq3GC4UF+Y+2avCiVBNKESClP3tAQgFIKIWUsXIgIhEIJAcrSabdwvCxoS4gh75bQiTgihDhFINNGky/kOX74EJ7n0KjNUsgrnIzHXXfdTeQHvPTCy+x/6xB7X3uZzVetobcnB2j8oE7GixAqg0Ei7QpGghVYKwijEGsjHCdDqF2OVzWHjzd+L1/IH5pr+eRzeSIdoRaVmIwTtAIETlKaD1qtGgNDDn/yfz899os/x3P3fvj6cl+vJrIn0Gaecq9AChsfD8CYZH1W4noOWc9BGIMODAafjOPTiXx6yorrtpYGxtaODLz66lFeeKXGbO1p7rh9I9VqjXzWp7e/xNx8lVJJUMhDxgVBBF0xT7hkCiPMiwzPt64jmtnM7q9+n63r4IaxElf3beD2zVfR6zUoSAOtWWzzBPnOMXIaNgjYsLbIDQNlPrZjHW/WMzx5fJ5nD+7lhbcMs36RTO9aOmIj/+Xr3+Cpbz7J//YP15EfNtDsUCwUkI5zsozm2XOqlBb/bOPnFc6vFCCIj7lI/lt08uP/L3cDzpIIQ3FJydXblHxVd9KCNCzokAvrd10X4Sg60zOsXb8BOaz4nT/6Io/N30uU24EXKGzjTSrmOFcXj/CBGyV3jvdx06ChXx+C2hs4pkYYQAdo2AJGDeL1jWDUMC8dajMVFnlussobk5KZ+QJCjNAURQqdt2gDZaGwNjkSImLt2vjwdVozFAqQyQqCUFNvW6ws8e3vHub4EVi7lsI9d625TYo5vEybrBugZAmsCxiMia8lg8YYGaeG6QAhBRklUBnJULlMfWqe3nyW225ay9gG54N/+/DEc3/25w9t/Ymf+7lJ7ebQAqJk+LCCheMpguQRH3YD3Pvp2w499s2nf6/v1cnf3XHjViLtY6IIrQM8DFqGiTAbn3e1uO+JCEQINjwph+XzFaaOV5mZatHyA67fuo21a9dS6Rkk9DWz0/PY2Tb5YolCuYfmXA03Y09JulEnpco4LVJ01y8ipNBg41KesfigsYScTOQ72ackUrpk8znqzTrXXr1BvHXojV9XdP5njUdg43HVWBvLbm/raUnPPc295a48tVRwO1PONW3sQiy/uFSvsG8fJuLUxnNrx3lgD/HN5fPKxUrOSjknxk/z2lkJFRdbcFqSQDZBnMBzviS1L3P6FLV3O0EN4n26/x1vYBXS6/dHm0Xnv0osBZ2PFDWSda1WEvLdliTfiXy2WgrYVxb9+0EhxEpjzQbiUqef5sqR1LqpjCvt85kmb76t5PASlqbapaSkpKT8CJIKaikpKSkpKSkpKSkpKSkpKe86IjIoDNYoHNfw5isHMpvX8bm+oiJs18hnskjpglBYoTDGgtEIG8QJRsRpal1zolhwCXWIJUIYj2azhevkkI5CiLgsHxAnUwlJGAR4nkcY+mQyHpgIKaDVbCGIuG3nHWw5tp49zz7PM08dYXxjkTVjA/QOKFrtaVxVwPFyZHJ5HEdRazZP7pu0EmVd0JrIgDECP4SJY1W++PCxL/7Uz39615f+v4coFosIG8sMi4UHRzbIqjdxBYQiC9Zh3bp+Zo+9xGd+kv/6wbvXl8ulBvONKbIZn/6hImHQQQiP2ZkWrsighEcmkyM0hnarRRS0qJTKhL6P64Ln5hio9BBEPo1Wi0xxhut3FBjdaDnwVpPd393PjpuHGOjPonWV/kGHueokc7Owbp3CIQAb7xuUeWlilkk/g16/mSOdMTKZj/J0vcXzr3Qo6Rk2v1Dn+jUhd1yj2FyeZEN5L5XsCdBVCBpQb6BMg96iz13DAVvHjvLp6wrsm4LXjzv8/d7vc+SEz+CQZdvGbQyPKGhPYLVBudlYTuseQyHi8yxPFROFkCeT00wigJ28WWclViyIarF3JBctqxbmFfKkvCOWKZUlBMnrp+ZNdRPyTm53mRvF3Skyabkgnk9YQKr4GpAGo+NnkhKTnucBlmw+hw5D1g0NsmU0ywtzB1DmUTYPTnPb5gx3XFem151l03AWEcyAP0PQruLKDgGQLZcQQQ7jrOWlyRwvHBvgrdZ6vvuyT02toUOOkCKIcpxwWHDZV59guhkw1uui/QglNagOUkGnA6XSANY5ilAhsycMc1WH555rEWrY+aECmzasoT59HGFDlIJMwUXKHLVqQNsP4xuaRmGsxHUy5LNZlAft5jzNahMpNAP9EaWyS9jyCcKjrOnLcd+9fWVfz34xJ197TySaGJFBihpZGaLkiVjukp2kdnByugVoCeQ83vexu3b9/bceux7KP33VhkGIOjjC4Hc6WE/FlqIB5ThoK1Bx2SyM9TGmgRIuOszgdyz73jxEq9mhWCly583b6RsYIgw1UyemwDo4Ko9UDr7vE83MolwPjEXr8KQuibEYEyXCboQVBkwYy6IkkpowCOL+oU2IthEQ62px51NI5SG8DIFu09uT5epNpd/84dOP/i833PG+QCOxUmGNRVqL7SYPJhdSt/9KY2OFcwXXQS1xLyWnF7aWSmFnm3D2bi9/pnSX6ybOrbTd81ny812ih/im8U5OlZu6N6wfvOAtSjkXxleY/jxnUBLyEud8pfzAGQhqlwH38/brFuJr9sEL2pKUS50HOH3yGcR96Uw4qzLB7xJn0oal8zxAnDK6HPMspIvex5mJsA9w5QhqcHpBbTtntq/3n7fWpKSkpKRcsaSCWkpKSkpKSkpKSkpKSkpKyruLlfjtAFcYCpkKYWOW/h4+v2FtJV/MuUgTSylCiDihKDEhjNFYK5CRRHkCdCxfWBFLOo6MhQCLRGhLGGoINcpzQSqUOlUmknZpjlX8kxUwf+IgQli277iJzZs3s3fva+zff4gDhzSbNo+ipCEK2tS1H7cxKfMYl5BMYpiEAeugERw6UuPFN068eN9nPvIzoeOiXBdHKaw1yFPS00DgI+U8VhokBQwezXbIkSMTN7/3Vu4o9TQJbRM328HxIIp8ms0AqxVW9/DGxCzV2fjwSEWUyeP0D5RoG01/3wDV+hw5DfPtGvlChtENwxyaPISjYGS4wNjIGM8/M8kTj0/RqMO2mwdxi73I+jwIn0Iui7AdpAFhPaDCbLPEbJijQRFULz4VfCTgUbUd5maPs3dugof2vMz63BQfvqHC1f2K6zddz3DF0qm/RU+PxvM6+PVXqfgdKtJjw8a17NgwzCfuvoYX9lZ5cc9+PnTHFjw5gQ0ihHROldPOELHErHlbUFo3ueykpKawFoRUSQqaIJmQ1DpdikUk6VUn0yKs7p7g+H8nhbolNo/trrMrwiWym41YiK2zcfciXqcQAoyOlxGG2rHDfPyuLRz357jjrn5u7FMMikMMOocR/hzMdMAqyJXIDI5zog4dU6bVyDJ5wvL9546zdybLD6ct006eoOcuWgyjk+PiyghFB2lz9JghqtVXkT1glcHSRkqPUhnqNei0oHewFxzY+9osb+0LWLsebrt9K4ePvsLUzBvk3Cx9/b0o12e+3qbZbCEp4WuXZsMnlyty6OBR5uebkefiSAsDvTk2bhig3ZpmrmbpLUe4eQfTDmmFDfqHRhjo587Hn3hux3ven3nOksMxLRyhEbK5EJJ38pzEGGC61SRHgbs//PGfeeEHj78wMtRzYykjMWEHpQzCuphuwVVrsRa0toRhiNYBlXKeRr3DsSPHOHF0Dq1h+46bGF07QKPdotOuYnGQUiKlE8uGREl/UwhrsDZJj7SAtRhjsdi4pKeNpTRE/Gy1jxYGSYSxGm0MWscyG8KAkUn9UYkRBukqdGTIZjRjI6X8vkP1/76cd/9FpAU4GTQWYeM+FktWi4RJYmFtJQlraYLa+UgSu0QSyS4aF3j/txOXAl1J+PkU8Q3n+1g9fSbl0mD7CtN3X8hGvEtUiSWS06U37bwgLbm49BCfz20rvH4Pscx3P5eGTJRy8akS94kvnYd1XQp9agL4PVZOhXuetwtVu4nLYT/AqeVBv0J8bCaSn3edYRs2EI+3l8LxOB+cj/f48yEPp6SkpKRc4aSCWkpKSkpKSkpKSkpKSkpKyruMZN3IZjozE4QtwZ6nX3Wu39rzP25Yu5ZyFhr1ORzpIoRKXCCBtQZQCGmxNkKHBtAIpRbSqGQ3bcpghUFYjQF0YJCuixReLIIIEJiT6WWxPyRBxIKPNnEJQUlERgb093vcffctvPbqPg5MHOSt16YZHgspFDOUy2WcjEuoE/mIuMweMgJjMHgYqzh8dMocOsZnNkoIonac7GZNksB1qqBkcQgpECIJRRaLRJuA6YDbnV4gXydoBRQLkMlAEIRMT0MpX+L556Z4+gf8m8MHeaVY4qezRapa8oTI1Juja+r3jYycuHfT+IA7vr5Cpx3QblbpUGVsxMVvh7SbTRq1Jne/f4TJg1O8+LKhXj/Bne8dxfgFgqCJ48UlKoUxZCKPpigyVY0lNVEugsiC6oA0YCKMlDScHprmKrTtYTb/Hr73+OuMFCOufs3hjqsz3DA0zrZ8nWuKJ8iEr+PXD5HJhVinzQDT5Jon+Oi6ItfR4IZ18wTNaYQjl8hpiUwmuiKNQIhE/utKgCuUt4rT0U4aY4AC6yyIbN10tcXLd0UzsWi6EGC66WlJShvR0o0l5zw591YuSGrdMqOLBTkbJfM4iRSXJFdJgbAaMFhUkgQmkEBORazPVflv79KUep6jojSiPU2jNk9RgJBZkBWqnV6Odsb44dEKLx8r84OXQ/YdgXLPh+ioXhr9PTRtng5FjPAQVsZyEhJpHCJbINLDTE+FmDFwXE2nE+C5gp6+AhP7m9TrioHRzXz7m09zYAK23QTXXDVCo/YW60cq5MtZQh1ybG4G3wjyxVECJ8+BAzMcmJgJZ6s8PDtT+3KzTqHV5j1CU3Hgv2ac9taPfNj+0y1XD9Dwp9ENS28pQhVzCD+LdnsYWtdmeGr+Nk/5zynrkNEKqzUuSVJa9zSy6PQDkfSo+ZasU2T/4epnxw8d3XPjliEpI4s2EY50Ti4QRj7CxOU4cxkXpYq88uJ+jh2dxpGwcXyU66+7lijyabeq6CjED1s4mSyOl4/HAGvBhkjrIITBWhV3CWvRxsTpaVonwlmUlO+MwMb/tiZ+1kl/iGXehVKzYnHfEhLpeOiojecIxkb6WTsy88++8qVv/v4t974vEsTXirDxwVmc9rU4AVAlx1CcehS7V8/J1DSV9PZTiuAmbVtNulqc3PZOS4bC2SeqrdSO1V5fqeLzua5/6f7bJYLt4h/PQwm/Xax+Q/ke4hv7K4lPKZcW4ytMv1KSfh4glklOlwR1Juw+96ZcNHaxspzWZRvxPo6TyqUpMV8GHuVUOWsx42e4nkulP+1iQVpd/D42z8pJXnuIJdbtxKLnHt6+P6tdW4t5J6VGL1XOx3n9Ciun1MHlPe6mpKSkpJwnUkEtJSUlJSUlJSUlJSUlJSXlHImAVpLyswy2RdhuErV9itkMutP5wlUbNhT6i0VcE+GJAgI3vglvYwMiltBM7HEYkwhIiQAlIJ/LYWwyXVpMZBYUIasxkUWjUcpDSIm0lshGdIWyxdlqjnJAZTG6hQ47RJ0mM40260YHWb9mnDcPHOLxZ17TlX6Ojgw11w6PDFLprSBJyusRly81SLQATYZmWx746Z/5iZemo4CMkvG8YvmvYYyAUHiEwkELD2nBzRgKZVpzTejoEG3A9cBxodkx9JX7OHYk4tWX+PNP/8Rtn//mN5/+9W03r99S7Mv17z968KZnXmj/75u3rv/k3z10cOz7T03/3NYt0//d1q1y46Z1FVr+PIcOhRSzUMy7FLIOR6eOUemR3H5bkT17Gjz71FEG+rO4LhSLWYRoY7VFKoUyAUFrEq+jGA6fJicPEaoIIySQB5nDqgK+FQRuP1OhgoGrOeJYDh45wHNHDtMX1rlxsMp7rpLcOLqZmzZcR9atYqI2hPP0ZiwTr71JUQowRVws2EySNqYAgcUiusUxhUzKdiYHNRHA3i5vJBKZXfi3JUnBQy4yTro9pFsSVMfpZo6XyGvuwmwmBHQik5mTy5qlFsqi5LRkjiR1DQR60TZNnFYFGCETUcW8LTXO4iS9zuA6kh4ZMB9NMvPmJMPXbkZ7Axg5Rk2XkGKAVw/7fO/NWZ49Ms9ThwxTZgBdvJ3ihi1MnqjiOi7SEUjHUrBtpJlD6ZCMbZE1DRwbIYxlRL9MNHMUEbpYN255qDWFUj+hbtLqhHz5b5+m0YKPfbyfrKvBzNLbA4VyBj8KmZqexYgszXaWyeM+33vi8P6jx/jDwUH+8j23bpl85Duv//L2HaVfGR4YXNuqRTNPP30w/w9+9mOf/+ZD3xjZMN73GS/jYv0QIy2lckQrCMlmsniOS3OGdlaAMAZX2FgIEwsheMnBW3i2IE2Bnt4+opblZ3/uZ1988lt/feCqdaWNhYxAG7BSopM+hgAlFSdm5zl+fJLqTG3yxFFGb962SV67ZRhX+NTmjsTjUa5EvtjD7PwMRBFSaRxhkFg0JhFwNdZEJxslgU7QWdRXTNzlhAGpwQQEuoklRNqFfq6NRUqBsRYlkrFUG5RUWOOgVAZjA7IZxfq1lcLR+anfsn7zX1SKA8gkSVIIHVc/NfH1IHTSz0VSYjQpmbz0ipIQi3CndtCFfp9cRnrZ9MHuuL1o6aWXzrJLdTl1PF+Oxdf7sttfpllnIpF12/m2UeMMSoiKxcdn6XqXbgtxyvE5dXUdshaUaC3bTmMhEh7RyrcBTncjeTHbiCWAXWc4f8rFYzm5Yp4rSwzYBfzHFV77URApd57hfBXiUp/3vWstSTkfjBOfo67sVCU+b8sJQ+OcKl+dbt7l2AU8ssJr5yp9woVPMHyAeP93sSCcPcjqx2Ol1LMfhfFjJc5HEtwu4j6wnPh+gPh8paSkpKT8iJMKapc4pVLpnJav1+vnqSUXh9X23xhz2tffbZrN5kXd/mq82/2nUCic0/ov9eO3Gue6/6txsY/PlT7+XOn992Kfv4s9fp/r+bnY7V+N1fbvcm//u82Vfv2fKxd7/Hi3ebffv8+V1frXpf75490ef6706+/ypsX/9GufwmM+/vHkjfQ4mUdZzc47boHSAN//9t/mtm/ld9b2O9Bo0Y48HLcXg8VYTVzh09JutynkS0jp0Ol0kgicrowBnVYT6ToopUCESAzGdvuYQdhYWhPWgFJxcpoJwEbEAWxJCTsrwSiMcSHy0EELEXYoKEOrepxI5ujokLeO8etylv/wxuHqL2W86me23zD+fkWAshGSiL6eImvGRimVXGarIVJmR/7zn341u+mGsY7Kevi1eiJwvZ1QwjWDw4kA46CIUKbJW4ZHtQY/rFDMVPE7sQuVUR4qX8H2lxHB7LNf+uunP/Cxn+j/t1dfX6DUn2e8vm6r17v3/3n0iYP9n/2Fj/6BFJl//c9/9ysPvPiS+c3rrpn/X++5S3mjfS6NZoegHTK6ro81YxH1egiqybXXO0wdjfj61zrcfAu4roM1Am0NnhfQmHmFYhjwhZ+8geOth5lue5xohVQ7WeaaZeZaFeZ1P57XTzZTAW8ILfvQJodbvAo/WsO0dy2PNeo89cM6JTPFDcNtrhk+xs7bWtyyKaTdmGSqfoirt6ylNteg4BXBnCqcWSEQwmJFLKlZJeMUvkT4sDK2j7qCl7QyLstqE9HIJuUVcUAojBALyWkJ8eYMmCC2m5wstWaIlTkK+QJS+tRr85Ry2aRPxSlv1sZSTpzcpDAyAgQSgbQRxhqUjWI5ReuTfbu7vBAOBpVEUQkwsVwZRwxKrLAY0VVzIkTgY4TBLfQSNJvM6kGM3MjE0Qo/eF3w8GshE60is21LdmCcaqWE7/SjnT78CJyyQuk6maiD61fJmSkKzFBxq/SqKdZljzOQb9NTdBjINik0GsyeEJQH8oAm1JZsDgoleOTRY1x7I9x0M3i5FvVamzWjLkoKGo0pZuqQy/cyW3V45skT/uQUv/3dx/g/Pv8/fDqS4XG+++3Hv/Dhu3t/f/t144wM9tGaD8tr+/L/518++I2XvDzPaBt8ptxTIZ8PEKJBpEMiP6SpZ5jeP01e82jOZrFSIZSP48iTgYtJ9cy4fyTPSsO+PQfprzSZr88y8eab2fdsyY1kXJdif4n5VoO3js0zO9+m3e5QLvVx9Mgs9Xr77+dmzF906jxY9PjlKBL/V7NaxVMtpAcaD61dOi2L45axxiKMl0hfmbjfIZEoIMSiEUnfkYsLEVsT91kk2vpo0wbTQogIksRAiYrlXQOVSg+1Wg0bWRypQEuUzSNxiWQVowLWjLpsmhW//cNHnvs3v/SrN7f3rxtFW0tfJUO7No+LhzIZnCiPEbDv2GtEKsA5Kfadep0YmfTdhO58QsRpgTZ5/5fOqeWNT8GuppmtwCmC16Lr6BzXv9rc5/ob1cL6T21/PGYsOb5anzptcbocPp/5+JoV318CyvzF371yOkHtbPgc8c3lSyU954zI5/PntHyrtbz8d4myc4Xpuy9gGy4EDxKLEMsJNWdTYm5+hfnPm6Ryrv1nhf57NglPnyKWmibOqSEp74hcLrfaLPezvGy5i/h6XiwNfY7ly9vu4syT8nYTl79cqQ+Nc2Z95XRJbOeNM7x+uuVLz5plrq+Js1zFlVLe83yxh3j8fIBTBfgDpKXCU1JSUlISUkEtJSUlJSUlJSUlJSUlJSXlHOngyuO4Yoo4hcpJZID4oYxE0aJYcbARf3r1VX2ZvNLYyOCoCsJxsaJNt0yiQFEsFhFIojBMysOZk3KSsLHEpoMQIyKko1AiRMpFX3MYA1JgdISwksCYWJIU3fUsSAFGWyJtMUGACiOy0uHo0aMUKn0E1vDsC/veqgz3/KFRFVyl/9gT+o+ffGpig4LrHIsQkCmXZ392cHD+4/kep2JFlplm5/WhtUXTU/E4Ua2ekqy1MhJlMigr0e0Gt9645cD3Hnn9KzdvKXxqZGMZv3GU2WpIqx7QmN+P33LREf9YCjKubHJ08lVaOk+5f5SbbtzExIG37u+0oz/IZHv47M9fH4X+8T949pnpv/Hb+sHbt+l7tt24nuOTB9GHjzO8JkehHFGrW4olF1cMs3ZsknJZEukQD4OSlkBqqo2Adb2wY2OLbMlBZnM0Wg4zdcWROZ+pRp1qlGGq3uLw7BvMNF3maj20dB5fK0Ljop0ygVtCZ0ZBDfHi3BQHZ9o8u/c1rhs+zlh2kp071uLkS+D7aKuQVp4sl2mS9CKh4j5mcIi/5koyyUSUCGNJGpmNc/NE8u9YBHMQwgUk9mRJz4UyifHPcXYf2oCXgb5hpqeP8/nf/hN+/1/+FhuGQGUERpwqFdlku0bEiUhdecQS/1sZHbtmRsd9w3blM5JrKClniiBOKFyU8kY3e83EZSutBGsQSHJeAS/fz1eeaPHKocO8NVFlsj3CXOlqWrkKIqsJLQS1CVznIDlXklUBvZkOA/mIgYKiPxOyaVDSm2kzUBAMehk29faQtwFS1hEYnn4cmm1LyQpcxyOwEaEOKZUhm4OxtaAyoDKW0fUlrA2ptjoEgcL1Kkwc8Pna1+YePXiI+z/64zsmbr7zeow2VCr9bLnau/+ma8fJqTaH3niGoKNo1wLyOf7My+HXajXm5gIGh2FoSJHP9VHIKiYPtXltD1/6xL23HWz7DpGQGGVQnoyHIyuSFLWuobboynM0EXV0pkW+D3Nivr33wOG5bYerkjcOTsxPTvF37ZC/bjbx89mmjSJezWZyB8p9ZUZGMtx+49Y/fOGZb39+dHB8U6E3Q2j8+NzjYHFQmEXVYuPzKBNJMk7a0/HDxu2TCoTp9kEDIkLbNmHUQlsfKbuFNWOiSCOlwHUdhLBks1kUAhMZIl9jjYOQcbKaIw1DfSWu3TyWObj38J+aZuPnpSPRCtq2DRmDDYO4r0ovdiRlFI+x3S66aNtWxOpld0yN09SWjGzdCDGrWZ6lY+OZymTdZEGzcKxgGRntna5/ZU6j2p0F5tRnYeL1Lmm/XPKetVC+tStt+6f8vBiBOE9tBWKR5z5iOehyZpxYCtmZ/LybeJ8mLkJbzg/SLGcAACAASURBVDc7V5i++wK24ULxIPC7K7y2kzPb5z0sL9lc6mX7VhLrVuJzvEOBJ+VdpYeVE6UqxOJZN/1unOXltMXznuk5foCVEwjHuTLGwndKFfi3wG+cwbzPc+UJVwdYXvzdeRbrmCDutztZkCyvlBLTKSkpKSnngVRQS0lJSUlJSUlJSUlJSUlJOUcitFtFi1liucYD4wGxqCaRZDMRf/Vnf33f+28f+uzG9WNEfgvXyaCUwirQicijExnt9RdeZnx8M/29vYiOIUrksu6NeXHSMbHowMeqDK6rQMavS2vixC0pMDr2JSQ2kdMWJAljNGHUIYqaWNPBcyRhFFDuG8EtVHjyBy9xbJZf613fj28yEIYEOqRUWXvAhQMCDVah3MKXH//h6z31kNuH11LOlQsPl8cKQVRsQdAmkiC7KUJvK/8mUTbeN6GzKF2kp9yDDYvcdevsfU/9/eTe6kT+6igI6XSg04k9rXI+5Nbb2VQswOx0h+oEqDda9I7so2MFxw9ysO/9GTrtDspxCcJePvSh0Qm/NbPzS18/8kdevvMr11x1PXPVN6g2A0rFLIWiS10LhLQUi1ApZeOkLx3gZhUNA0dmoOyA1wmpdw4SRj4jhX6GlcuNYx7WcQjtIQLtEkVZQusy29jLVC3k4LRmsukx5Zc40spweBaqDUno9TEv8sy3b2POP0q2fZw7dl4DXhUnqoMIMDiIbhnYrsSFRFgHRR5rXKTUCBHE59hqEEnZWZvF4CBRaOFgpQvWQUp34USIBYmoKzHZbgKbl8U6OSQ5vrnnCN96HW59corfuG+IXMZidXBKglE3McomKWcWiRESnWSeGWHR1uIiThHbYtnMiVPUrIzbkZSVRKhEaDJAhJEiEYEsCA9pDT2ORz67if/wnUkahRuRXpFQtMmqvQxmQwqyhdOZYt1VltGyZt1AhsGyYLBo6clqymWXYkaiTEjYatKptdFBC1VrE7ktjGqhhUSVYaoBY1iUMGg0Qdiid7BI7mgDL1PAzVicTA6RcZifn6cdFjh+QnLieMTD32z+0e13bv5Ht97RQ0SWnGOQMqLgGva+Ehzc0PfidcaPMAGEAWRy8GMf7hlrtKs05gNabZivwusvawJ/lt5Kltdf7ey990O3/KRjy7hSopTGuAJLhBKgF5zD5MJLxgAFlGeoO5bAsxTGssHkvs77jz958CNHT1DraJ7avr1ULRQdesuSVquNV8wjcJHSJYwETT/iyHT0a69NHPnGnUPXogMb91ciJAGSKBm3NMJGSWpaUsJ1kdwVlzVeUodUBhjmiaIW2iTjKx7CmjgtUERYG6KEoN1sMTczy9HjJ1gzPEKlXEZrS0Z5cf8ROaQQhIGlnM1zy7bRzz74H//qiyO3XvflFoIQg5txEMogdYB06wgLxtEIGwue8di7yEDrlmReNLa9vTzmKvUyl7B0jDQnN3e+kqCXrmeJEHbW2z8Loe4d8LZSxQv1Qd/xOhdxpjfiu+zk8hbU7uftYsY9xGLHfVz+ItfOFabvvoBtuFDsZmVBbfzCNeOi8DlWFoyW40e5bOGlzOc4vWi4c9G/d62yrrM5x6dL/drJmY0XK4lZV0Jf20X8fnA+Sp5ebkxw/vZ7N1fme09KSkpKyjmSCmopKSkpKSkpKSkpKSkpKSnniEEZg5skVmGjhRKKFhSGv/mr//eGoT6+tHF8FK1DHMdBuC5WGIwS2EXCEUClUuHlV16kmMtz3XXXLWc8AN00NTBRh0gIlFJJ2c9EEFqckiTjm/zW2EQEMURaY4yPth08x2DCiGq1hpOpEOoMrx5ovLjzEz/20NMvvUXHdAj9NoSaDBJHqDg5yCrWDIyw/fbRakfUvunbJnU9Q5SxVKM2Xk8BKzpxG5bZDUFS7pEAZQMUhvrcPJ6c59XnT3x8qBdbLbboqwjGNpao9GaQBFhCCrkMcZnAAnO1KrO1GvUAmk3LTVt5z3ce+vo3jh7nLxyHL+64eWu70zYot48bdnR+9c+/ODX/yU/6X9hy1Qht/wiSgHwuR6mUZ9+rh+n4oBxwHIsJLUJl8I3DVM3npmuuozRyI449hg1mY1soqhI1qzhKU/LAkWB0fNw39SjMUJHO1gE6zjDT1mXGz3Oi5TLfyXPshKE6D/smAqrTs9yyYws95SxKWRwVYQkQQiCFwlgWSWoO4CKsg5ASYS3KJOljycMmCWtxcpqDwcEIByMkQp361ZgQFtntI93eLSXSy1Azeaq1PH/zxAS3ffaX+MvHX+X+n7oaL1Mh6vhxOdkEK82CnCYWBBdJhDaKpNgkkTA4mNg/Oym5dJ9N3DsEIOJykFqoOE0LMIRgDZE1uFJhQ5DGoeRl+cCdN/PyjMIRddYNOfTlI0YqAWODeUYLaxktdchF03jBcVQwhwzqCN3GNEC1QUiJNhkyToZ6IKiHGkuGbKEPNz9AI3+UEzNH2SZdMjJEWE1ofErlCtlcg5npJhtKQ0jHYWq2Rq0FGW+QY1M1Hn549g/uvH3rF7Jemfn5aXp6LQ999S9yJ6b46Ztu5DO3bufOZjOivwdGBgtkswWK5R4iYwl0hSDooHUAwtBu1mg2LNVZnyjAfv97z378gx9+799hRHIuLUIq7GkcHisgcttEMiKSDoVsmWyQrZXdgS+uvS6L74e0anMIK3Edj1IhTxTFaY+e5+FKhZPN8aGPfvCh5/d898WrGtGNuUwWgSFrDVZ3knKzoE2A47gYG2tpQiqEMZyUjKzBJDKXFRZrLdb4hKaFMQHS5rGmm4llYhnTghKCKIo4ceIEhw4dY3RshHypiHRc2q0WQoIjZZzmJjMcP3acocH13HDdEIdn6l968uVXb9x6x00vZTMZfL9NGEZxAqAKcEzcFyXLD8PCno88spR3xnkR9j5HLBqsJPosZfx8bPQicrq0oge4vOWKHlYuuXcllqHbfZrXxs9wHRMsf8wu9X7wYPL8AGeWpHap78+PKqslni0+t7+4yrxnU25zDyun8I2fxTo+tcz0s0n2u1SpEgtqz60y3zbicfdKS1Fbjks9VTIlJSUl5TIiFdRSUlJSUlJSUlJSFugh/ovRNH4+JSUl5axwyAZFCrZ1UhyqVHqp1zroyPDSi8c2X3sVj9/93mvoK2eJOm2UchBKEkkbS2oCEBJpYtVhaHiY/t4+nnrqOWr1J9ixYwdRaEA6uG6GUqGAjjR+FGKNRhBhTRsrHayRCCEQixKtEDqW2aw9KR8ZE2F1hDUBgk5cTNGGFHt68fKjPPLkq2iv/E8Cisz5DayIyxa6rsDquGRoHGClaUSzaA1GWUJHozIebd3BIhPBI5bTFgsethuKIwymM0+hVGS+UaWSz/P0Y9/rGRvmP3/0o+VPXrelH8I5pAiQaDKZEKUkBoEUsbjlCMtwzqV/qEIz6OBrg69Vpd6IPlprOB995tnOv372iVf+2MK/u+bawRPCcbj19uHf+s73jvcUitl/ONbvIXQLRxkqg4O0WodRDhRLLlb6iGyWZuTiU6AtWjw5tZkX/F7WjniMlvpx7BR9+RaV4hB5r46KZiFoIXS848aJCG0dHXQgnGJAFRjK5thaKqDcLGbcQcgc1VqHY0cOImyNUd1Ghj7SBWyEQcYFYJ0MkImTpKwDwgXpJdFYIimXaSCTBxOhm22ko5BeBtwsCIcggmy5FzI5dKiTdQiU8pK+oU/2k0hKpFemFRb4T1/dyzPVEjd/6Hr2Tb7Of/neq/zTT9yJE03h2iBeVhuMtSdL00IspglM/GwjolYNQgcdtfG1RiEIgg6OhGwuhwnikn1SOoQWOoFBY3E8hZQy7vMmwmCQaKwwWOmAyTHs1vipqw/z2dv7KOYNPUUPz1HoqEkYNbBRE9Vu4dg2Svu4VsclUE0GHfm0BWjXQbt5bKEPUe7F6gJznQxTs4Lq4Rx79mVx6ob3hhEuAdaB/v4yfhukAh3B4OB6ZuYP0/IF+cI6Dh3o8NDDs3/8iY/d/QXtC2rVKX74gzeHcjl+bfv1/Mq6e/PD68dLFDIhJqrjCIUjFEgfK4+BsmSykkwhFh+1MRQKGfoGBYNrQsavzm6ZmGh8/ennHv9atcYvvPfum6qOzKHt27/+tEtEqxBDABgL9Y5POVegHfqEgcFaRSZbQmqD0RZjNUrFqWdad9AahJej3dHsn+KfVF4/tPt9d96Ap32M38GRAu0Slxy20GyGeG4epbJIvLiw8aIylTJJUbNGY61F6xBjJFZ7yfgqcDOKWn0e6QRkPUmj1eL11/bSbMK2bVdT7umDJLkvUyhitEALCSIDxmGgd5hOo4GrLHfetIlq84UnDj/1wvbrtm7al3ezRHiERmNMCEiUXdERjoewswtIe7vQ9rblz1S8emfzybeVAD1X0eudLv9O9/O8K4G7iH//eZD4hvuVyv2cXp643Pd95wrTH72QjbjAPM/y523nGS4/scL0y0GyeZBY0vsyq/fdy2F/fhSZ4PTnbv4s1nW21/lK5W3Ph8x4JUhbe4DfZOWyql2uhLLXi1mpX1zu748pKSkpKZcQqaB2ebJzldf3cPl/ADwdOy92AxImWPmX2EuRHlb/BWP32azQWvv2MgMLbOf0f1kxweV1/M6VcZb/C6Qql8dfMZ73/nOxWaH/jnP6vxS7XM7XSiy9Li+1/Vlp3Jjg4o0Xq41lF4qzfW8f59L5y/bdF7sBZ8h9yeMXib/YSwW15dm5yuuX/OfQZcb/M3mPu1DsXm2GVT5/LWXpGDbBpfX5a5zlx6oJLq12ppwJxkFFeZQtdicwe2wOz/M4cvD41Tuuzz15+y1jpdHBLFGnSdDxyZcrGKkwymJOSjwKIQFjcYREA/d+dCePPfYYDz/8HPe8/3pyhRxKKebn53CUg5PJ4DgORlu0CdA6wlqFkhIhRSKqCYTR6EQa6opDxmq00RgbIAgIowBFnJa198AkT71w6LF7fvwfPGpzFbQtAlGczCYMSmiQBkGcfmRlB5BJGT0DshM/klJ+yyFsIqlZMKGgU2swPFDiWw9/r3ewnx/evXN0/OrNFRr1A+TzPp6jcFURIRRhaLAmLvco0UQ2SiQPQy7rkJOWMPIpZg19JcHIj/UNTU2b335zf/XX33zzxL/aceu6f9UJYNvW9b/yrYcP3vjffKrwnkJPlnqtTdCZxFpYsyZOfEKGONkcbnaYAwcdnprwORRlCBQU3BpFZ5YNfZLBQo6h/jyDxQrrBjZSykaU8pJC0UV5EJk2nU4DYZrkZYRrG4jOFKLhk3MlKuvRmw0p5jsEHeiVWcIgQuYyNOp1vEwJkcmBl4OGQYcRYQC+Nni9BXA8XMfDcV2QDqhYWnMKArwMjVZAvR0QCMV8O2B2qk1bt1GZPDNz09QaLarVKo1GC8dZ+MpMC6g261TlIH/9+AwDN9/Dq+0WxRtu5N9/9RHe2j9JTybAtcHJ/iaFRMh4zJYYtl67BWUjlI1wbMjG9WO4SpDJSzLSUs5m8bSPIJY1pfbRQYivNZExyKxBEGEin0i3ECaR9aSNU7cEOAogQjHHmPsGym8zWsoiQkVrzmBFFtd1CK0isgojS5AbwIgSJigTBC6+sbSsZLplOTETMjnT5FjNMjFVpR6UmG/nqPkGL38DAyFMNQ6yfn2OdqtNGLXRRjA0DEePQm2+Q63RJjIO1aMBX//qocd3vu/aX23X6gStOs89ve+f3XU7v3XtllJlzUgfVjQxZoYojHAVuE4UlzkVEpV18ByJUhKtDb7vI61BKgelDDlrmJ1usGGzZNNVoz/+0MOTe77znRe23/uRW6qdzuoSkEki1ozVC1dsNwVycaJdUl4VYZPysQaDQ2gteHk+ct/HHn3qiW89tnm6fld/HvJBgFEG6bpx6p0Biybw42RA6XhI6YCwi0p7GrQxGB2nPGoTYUy39GcIVlKt1ul0mgwN9nJi+jgvv7yPnl6H9+24AbNod7UVcdljCxqBwEPKCM+1KAOhX6evkOWnP3J78Vu7n3r6xe+/deftd2za67lZQhxCK4msPmsBLeWyZA8Lpd2u1BvR91/sBrzL3LfC9N0XshEXmN0s31/Px+9341z6v5NMEO/rbs4uQSvl0mA1uXDx91IryZhdJs5y27s5NxHpdNvr9snLnQeIx9XTXVs7ubIEtUv6+7yUlJSUlCuDVFC7PHlkldc/wJXxAXAlVtv/C8XvEf+F4eXCdlY/dmd8t7PLaW6SPsDpP7xfbsfvbOlhQXbYyep/qfYo8XX7IJfmlx/vSv+52CzTf+/n9GUtHuXSkWTPlB7iyPjPsXw/PEDc7x7gwv8SOs7CdbLaF2nzxNfIbuL2Xqi23seZlzp5t5jn7GWz+7n47e5yKY8N48TH6n5gw8VsyGXEFfE5dMn4fybvcReKM7peVpHUxok/Y93HyuP+A1zYsbTL2Xw+6o77X04e6RellzwOxpbQthNLGyLAqIDX9x/fsHadevrW926pjA0obHseqx3yuQJGSIxS8UPH2VhSyDjCCI3rugRBQHV2jjtuvZ3Hosd45JGX2bZjHaOjI4SRj7UaI0ApF6Xi8o7GxNKItQJhJUoSXzOmK6fpk622VmMJQQRY6xNFHSw5WvN1pud8vvINfv599/WQKY5h9FAipEQIGyBEByNisS1Ox4pQgLAKbICkkZThFEjyGAGRBMe8PW1IGo/ByjVo2yBoH6RY4m8/+ak144P9gtCeQKg2uZIDGsLAEvgGrINUDtgAYTSgMEaAiLA2RMkQqTTlLAQyxIlm6duY5erxvsr+zfP/8sknD/3CU8/wjz/5iaseaRznAz94otn44Addp1QqMvHmFGEI69YNo/UMjmcxwmc2lPzgUD+vtNdhhz7KvB0hNC2sbbFndh4x1cC+2kGFTdb15yhlAyqFiGK+w6arCvQWOgyXNUO5FmOFJmU1Q0k0yKom9akDFA2YAEwHslKCKOI6bXA8sjkby1g6gE4LSgMoUUapElmvyIlQcLwdMTfVoFFvcGSyihI5jkxO8/K+Q8zbLFP1NoFQZCq9zHUCZlpNWtqiMllMaDFGE+k4Oa0rNwI4NqDgWWb2vwi3/BjOlk1UO/OMbbmWvS++wp/85bMUrhlHEiendcUiY+KfpQX50PcRNk5QU9bQW8qTURbPUeSFZrjg4EYdRgb62bhuDWtHBihmPXorfZRzljUDkpxokXU0jmkS+rOEHY0JOzjE5RuljEBVAYlyQ4KORWQd8H3yoyMYXaCpM/imTFNXmGkojk9ppus5Jqu9TNWyHJmKmKkKGiZPR2doWUkoPKRbQqscoVAEGYhCGOtE7D18jG1rerCmTdBpg1WsHS3wxmtN9r15gOGNZeZP1HnlhQPh1CE+IG4MePS7r31gfJR//8u/sGbr5s0u1epBgmYDz3PIFgTSdUEbAh/C0GJQ6LYBpZGOxA/aSalMQb7g4WUkShrKPaDI4ag8t906uKFWPfG3rpIfzLpxKp4VSYKiXfKGK8CJK66CsChrcLVEaQdMNha7umMbIQgfZJiMdRHYPJGAVghuJs++yeizA6+9OXHblrVkZYiSYBHEiWYhcUFjidEQ6RDpuLEYC3STsoyNhTSjDUIYEAFCJpKalUjHkC+UmDzU4Ic/3MfIiMONW2/AaE3HDym4GSxdSVdhkjRAmZRdlhKcjEUR4PtVevssH/vQTb3KvvDU6y+/tX3txvGJQnkwLlVr/CRxLOqOWJya6BUn+sFCKduu1Ne9huySyLqlCXZLI9SWJk0uKri7dMEldEulnv4j1eL3gZhTE8nOfvtnmmh2ftoPi9ovNOL8fcVfJf4c+aXztcJLjCv98+RKgtql9IeJ55vdwG8sM73CmaU4ne7YjHNpfke7HPcD+y92I1LOml3E1+1yUtg8p9472cXKY/M8q5cLXcpuVv7ecDurjxsTZ7m9y5X7Of21tdK4eyWyk8vg+76UlJSUlEufVFBLSUl5x5xlgsePCj0s/HXN2cSn35M8fpdYgtpF+oH/XeVHpP/eT9wfT9cXNxD3u88l81+I1KjtxH38U2exTCWZ/1PE8er/KVnHxPlt2tt4gJXlvgvFxZAHr3TuJx6nz6YPplwhXO7j/yrt38XqcuoG4nG0O+7vPk9NOx2rydLLsXjcf2DRIx0PL2lkXG4RQAQcPjRXGB/nyR3br6r09rgEfh3j+xRzefr6h5meb2CQIByMiJAGhHRARBgraXXiEodRGOL7Ptu23USz8QLf//4hbrihyo3XbyHSEZ1OkyiylEoVXNfB6BCTRAg5VmKMPbXUJyQpSN1nE5eBDMNYBsl5HDwwxRPPz37+3/3JJydsOUO1OYcV0UJamjDoZFlJXE5Sy0TekJauyCEsCCQYD2s02hQTOSbefre0qbTQavpYmnz7kZc3v+9udg6NFmk3JunLF+nvW0ezMUO70aE2V6PZMNS6RX+S5SvlDIVCkUKxgok6GN3Ecy3CGBzXMjbqMlvt4AcdxkZcfvzjg1vXjR777je/8eY//4lPjf/Otx+ZuPe6a8PvFK6ucPTYHIUc5HPQbmtAEIaaA9WQPccq+EP3MNnsI3CGwMshHFDSRxDhlV1kFPJSUEPW5pHVeTAnkK9PklU1ejIBvU6DtaUma8o+44MFhst5RgbWMVzMULAhdX2YvOvT543iY3C9PG6pQL1tmKkF1FqauTfrVOemOHq0zqFayLPT88yFik6zSdTq4NfAn4ONI7DjllvI2CwzQYdaq4EIMtSEi7tmM+VsmXYgKeV60cZiTIDWASbSKNMmaxq41qe33MOM08fwLTuomjbNqMPew02KV91Gy+mlp9TCtR0EOUKyBKJIKB2sE4tJCoWyhqz18WyLdvUQIqzhN2u0gyajpWGKPXn2T+7ja99+FjcDylV4uX5yruSasSyDFcHgcJ6eiseWzesZLK9jqJRH+nUcOri2RcY2EBhaymE67PD/s/fmUXZc933n595bVa/e3nsD6AbQWEkApACCJERtJLRYsiRHpuPIihJrBCce2yfjjOnkTOY49iRwTiZz5thjycmZ4/jMOIIy9tjW2BYlxbJEbSBFiaS4AiRBkNi6G2ig0Xu/tV4t984f9V53A+wNvYAg+D44ON39ql7d++rd+6u6t773+9vg3M/Vqsel/oDhgmF4VHO1oLg0VmKq5jJeFUzWoIhLIDeCbAerg0jk8SOHwEhqWhOEEUYDlgQLLEsx6Q9wajjBxUlNNuMSBB62jEglk7Tmyrxxtsiu/Xfw/AtDPPcTPvbzP7vN/8EPzv/ug+/j39x7dzeZZJGJsSJOApKZOAGq7weEVQHGQuOiTQqMxdlzF9EiFjYFGlIZSKcNYVgjiixy2TQdbS5hYDE2Mk5fXzfbt49+8LvfeXbHBz/84DkAbRyMtomMivs9sTua0RUCnULjo3ExUYoaWSyShCJBZARGWgjtYAjQ1JAimhGoaRwmvRA3mWWqNMHPfOrDA4//3ff+xdYO7w/yrSlsC5SxEIRIo2eEitpIEBIdBggEuh6XhBCzgi4xmyY2/hmr61zX4fVXL/D0U6PcsTPNrl1bqFTKJJPJOLbUVXhCWBipQBi0iY8bJ8LVSKlQCRdHhkhTJesm+anD9+W/8c3nniqMj+40JlFOtOUQ0r4u1jfO3dy/1+/eSpi6JO4tun17q8tfFBFhTIJAptHGYT4BnE+O6+V4S/AosdjhdkwJeIzFx4Bfvkn1WA8Wm4e8nQVqi3225bg4LTa26LvRyryF9LO0w1aTW5MDxOPko8z24QHiPt0/Z79HiRcEHuPaBZZfrr//RsfJxxfZ1sfq4sbhJY7/dqKfxftWnuUJ+t4uHOfWWfDcpEmTJk1uU5oCtVscrZdaWbc4b+eHbwCpVOqtrsKbMMbMpFZwHCdeET2TauHWYrXnb772I4RASomUEqXUzOdeblu7zc/fUdZGyPIQ8IN0Ov048YPj/saGueev8ft6nb/1aD9vNW/39ju3/jOpg+q/z8Mx4lSFyyVPvBLvl4Bj6XR69RV+Mw0B543UayE+X///h8R975qJmPnqfyP9Z077n6rX+a0cnB+DG2t/b/fr5zrV/wCzbmk3HKff6v5/M2nG/7eWVdx/HePG4utWYue4X2JOSoqlyl/G9ed6rp9sXwl56mLqdDp9hEXE1JVKZRXFNFkNaeCv/vC/JyuL1CpVuroSTF79yt++794tG7b3dVCYGCOIQtxkDpNwGSkVMUKBcJDSJpvMIg2EXpXIaIQwSKnQOkIpiyAMQEJbe5JUKsKrVHj8ied4z3v2kk5mmZiYwrIEQeCjdYQx9fdHBqnAyGvjtTYGopAw8tE6xBCSSCTBzvPy6Qv83ROVP9t3qPsPXh86hXf5EoFwEIkhZF1cZtBgIiIT/66NZrQ8GQsYjETLECM1WkhAQGiTzdwBUUtdhKIxsi5uERqbEp3daYim2NLLI9u3tZJJpvDKKc6eHacwGeJVY/OwagUCH7wqhHVNXORD4NewVI1kcpykA3ff1cmGjRtRIqBUHKZY8GlpUSAiKtUAmwIfObyPO3bV/pevf/3svb/42Ts/efz46T9JJ8J/aiLYsy+LH40hpAGjaG/t4coZeHkoTaFrGzqZQeCj8TGhJqrHphpVEBqjNNJKoEwLChclu/CFoShSXDaaVyZKqKsl7FMVVFRGU2Dv5la2yCr7N+/kU59o5UThHINXq4xMBgxeGOHiZI2TI1MMTUyCCfBrGiEyqHQHJXsT2XwO4U6StkbYtrHIJ+/dzMPv28W2nnaCSsTA2EZOXrlEf1nzrRcHODc+wlS5lYS7haAGAQrfVIjCKqLmkaxeYlfbNA8c3E/J6ubs4CU6c4pXhs9BIouyW7BdcHWJX/mpdjoY59uPneT0RYNofxe+k6NYKaDcJMZz0YVp3HCMVoY5uAUObs9wcNtO8gnNnbu20NGRZ7pa5PnXL/H/ffcUz7wRMGm2MWZynL1wFUEZX00TyRDfv0hnMsuOTAsbkpLtPWm2FCCsIwAAIABJREFUdiW4e+tONnW3Qm+GZ954nT/5L130T6UZRlHSaWrlLGHkYmwb41gEShM5El8INA7KJMAIhA7qNlcSIyVKQSTBiChu0ggynX2cuGTx0mWb99/dgR1cgghqlTJ92zK8fr7Ei88N8OpJ/uSXf/mBH3z9b57+5uc+1/Hxvq1p/MIVJD6pFLgu+IGkWPSpBWlKVYGj2ugfvMKp09NoDb4PbhIsG6SKs7wmU5BwIPBCknZIJlumrR3SuRStrYbduzbyzJNXHkkmxD/v2dRLIrWZUiVDtQoiaSEtB6GSGKH5s7/8Sl2AVEbqcSwD0sSiuXrUQM51+RJzfgr4THYMZS6hCHG0z95d27/w4yfP35t/8L5/3K1c3MDH0TVs44P24xgiYuFbLICLoJ5m1BhQlsJog6k7qZWLZZKpBEJIPM/juWdfQgi47940xkQoEeFYijCMSCQSdUF7o4oKZStkVHeNNIJI6PjTWPH3W/UKSOWRtDXvffeODT98+sI39+/f8VCYcqn6NU6eeBE1Z4ry+lvgbM4FmPGBm3UCu/Z0LYS4Xlg1zxvkfLfd4jrplVbzv/4mrk29vOLyZwteorwFWHH96xiokeIvvnEFf+5h5tRfA5Fw3iQpXILj3J6LeR4lFnPMd898vVvRmnGTxucLufhMs8TCvqXqV61WF93eEMaulKWOv8T9fX8qlVpIULnaNIN9q3jvslnD9nGc21Cgttrz81aPD5cqv/75Gg7nB4jnIRcSOx0nbpeH63+/VKlUFhWmLXH+FhJeHWDpBcyLCbJalnjvTWON+tdSqVgPs04CtVus/R/mupi6zPa94u1LsdryV8tS16/bcc64SZMmTdaCpkCtSZMmK+bt7kCyhvSx9EBlJTxEPLg5ws1xtXpHcZu330dYuQjsS/Wfx9amKjMcJm7Ha70K+zfqxz7C+q1Weytd1L7MO8c2fz1opBN8hNtworbJyni7x/8F6n+M1cX9Kdb+XqOlfsylUjjfCA0x9UpXiTdZZ/ygQjWaIukk+Nuv/9Wv3r8/91BPZwYRljBBDTeVxUllCLXBDzW2sBFIhFCx85oBhI0QGoNBCIWSNkZojI7QJiKTSWNJzda+zbxx9gTf/d4p7j24mQ3dmyiWJgEQQpJIJJAmjAVkEQhzrfwgikJ0GAEax7GwEi7lapWTp97gxy8Ef7r3vtznfGnhK0kkfCBEyhLCzDmKNhhRz0gqIJJx39Sy7i5k3Fk5i3GJcIEkmggtQhD1LG4iRBGScD2Of+eJP+7bwq9Mjk/y1JOT+AH4HjgOpJOQbYdMJovRCqktZlzrjOTqyFUqlYDpKahU4LkXR8meGaWnF7b1dZJvtRkaukxPb5bWFpfpqSql4gXchMsvfGb3J771d6efOX+B//2xxy59YvdONiJ0nDpOgsZieEJz4aqhJLsoRGmMsAAfhY5FeUbFEh4JoGNnKOGgsQgiCZ4EK4FIbkAoBy2qOE5Ai22RcDSDl08RTdZ44ezTfOv4Sb77Yply5RKXp2C8CPnW7QRuB9X8TsK+FJYtSVs2MrQRUUg6qGC8cbZ0JfngPQ/wkbvb6LVG2KBGqJx/GQlsSiRp252mlMjxoffu5uX+AifemODiSImnXhogtFuwFCQdw9Yui4/cvZ+fuyeH5bbwu//v6+Q3bqJcrYISoGIHvIqKSLc7PP2jb/BH/9Pn+PjdO/nJyVGeHUnzjWfPYtuKMKiiKiXu2tbGvbu2sLNjI/f2JdhgF+h0IqywRHXqOUpFcFMOD+3pZcvmD/LYCxM8+brghdence00uJ3U0kmMm6GmU/jVkEvTFUYmCvzw7GkyokCbKZIUES1teZ4/XSbMfBTTfj/l3CaCRDtuqg0jEnihIdQByLoTGD4YiETcrqSQSCMRWmIEhCqsm2Y1WrVFJUox7ezlzPRFDoSTdNpphF8DBJ3tec6cL/HDJ0avDF3hmz86/vRPHv5E5/1dXYLJsQFcG9L5OC3tlashStmEkcvYWJnXTgdcHS2SzkJrG6RSsKWnnWwuSSqdIAiraOOhdY2aXyasQeCB58GVS1CpVWhpPY3nwQfer379iR8+7shsx686CUll1COZ2Yi2IZASg4PGIYhaZtwMIyCU1+cBvZ7ZWKBMhUBYsWOZBoPEyBQ923b84je+95x+98Ednzt0cCtSaYJSiaBWxnJchBVhZOwiaUw46+wIpNMpqpUq5UqRcrlMPp9HScXQ5SFefeUq3RtsHnjgEE/96EcoKbCs+HtRQmDq9wlaSIRUWNJCCgchwUhNFAWxo6OJ95HSgHLRkYclPXo2ZNize9ODjz76zV/96C989I+NuFbMNUO9KSyZjfKGaAiz1AJ/rzdrXH5DaGbWr/4GCx/wyMy89mYB2g0L6F7i9hSoQTx3cIxrXYgeJ7637H8rKrRMWohFI4eJ5yH75ry+2Fh3itvLzWg+XmL+McdyRDLHF9nWt5LKvIUcZ/50p03eHkyx/H663P2WU+Z89K3ivRDHqtuJ4yy+cPkw8dzx7cA7cY6lMXf8MHHb30/sYthPPKf1KLf2/UGTJk2avO1oCtSaNGmyKt7uD3nXgMZqvPUSrlzjarVOZbxjuU3b7wHi1G2r4UvEE3xrJfg6wqzwbT3YT9wPD7M+IrW30kXt6FtQ5u3AYWbTeN6OqWmarJK3e/y/rv4Ps3pnymPEE3FrNRm53vdHn2f2Ad07cQL1lsQAdsrBCQXf/dbX0ps6nf945+4dKCIqxSq24+KkUjPiNIwVuzJJiUQhY1VTXaxWd+ir/1dKEoYRWmvy+TxTE1colQocPLifZPI1nn/+Iu+6O2BDbzvaBBhjqNaKWEKhLAVYxBqq2TR5QtWFHFoQaUO1FPDE86eii6P8qz339/7BZCkEO0OAS4BT/5ASOVegNmtPdA0Nlx0t6tn5ACN9UAUQYZwSVIYgfLQIMQRIMcm3v3XqK0f+0aFPv3rqRYaHAtrboHsjbN7bQsJV1KolLEvhWBKMIPIDTBQXYIQm2yYx0kIpicBh7GqJ82fg5CswOjJKMgn33LsNz5tGiBot7RZeMIVDQCqT46Mf33FIy3P/18B5CvfdlwbtgqogpCFAcaXgcu5KhFAZotAg60I8aeqiHm0hkBgTi9MiglhwIzRKJXAzNpZSGFUDq0Jx4gKBP8Z4eQRqUxh/ipHyAFs7S+zZl6JcKiLTm9jQadPqpCnSQi1QeH6Rqu8RhjlEFJCtebQHw2y3B/jkvb18/MGD7OhM4E+eR1anEVEVy3YwIsT3K9QqJSI9Ql9nB7u2JPj5PslkmOPiz+/nLx47xeCU5v2H7uaT93eSrQ6Qjyb5xtOv8vKwJrHzg0xWI6SdRJsATYGaXcPdmOb5Fz2+89QrfO592/nEgZAHZI6PvOdBjn3vHJcvXuKff/Yg+zZ6tOeLmPIIdrWGUwvRRY/IxCkyi5Nj6BI4xtBaOMen97Tz8T0ZXrns8P2XRvj+y6cYHnTIb7mPSNhEERh8ksmA1K4uUqRxymlsv0IQVbhvfzehNcUPT/4V1am7MIk2AlcirCztG99FTWSoSUGAwkQKIoXQsTBNGrveLyWB1KAkqBB0AJEFoaBickw7+zkxWuYDxTKbujOAwIRgJSTpDAwNU9uxg//7Fz+9rbUyeQnlu7TlW0lkBNOFCsbk6dqwjWefOcPgwDjFCnR2w7t3QmeXTWdnO7aVoDBVBCooUSbtGpQlQSiMSaNDnyiKCLUmMpJI27z6co3Tp2HfHsnP/dzBX/mj//ps6+Zk8he6NmyjFkziywglJKGxwaRA+EjjrCz+SY0WmlDURWYCSoVpejo66Nm9/b975pVzL01W+3/vzr5W2Z1VpBKCKKqgw4DIRAjbRhMiddynIq0ZuVqI44kQ5LJJoqjGmTP9TE15bNxkc+jQIQYHBxECujd0I5VCUY+ZUqGFijW/qDguGAVSIqVGKgjDiDDy6sJghVAOmIjQVBHSY9/dW7kwOvofv/m1x/70pz/5iTKGuf5x8e9zYt+sQ8S1QqhGemVjlhBINd4+EzT1An830iNf976Z4+gFNlxPeO2fWq6s/Jlyr0sjPbth3vdfv3n27+XWf/Y45vrPsjbcMu4368RxZl2I+rl1Hzw3XMAPs/IFVw3X5Gnie/4vcut+3pWy0Hjg8CqP27fK999sbvd+22TtOc784s6+VR737dgW+4hj7gGuFQHD0nMOh9ejQtfRRzz30zi3/cTCqbWeD1lsXv3wGpfV4GGuFTU+ukQ91pKFHP+31v8/RPyc5Q/r+zZp0qRJkzWgKVBr0qTJinm7P9xdA44QT+zcDPHDerlavWO5jdvvWq3Y+iJrM/D8IjdnBWee9RWpHePmC9Sa7mk3Rh+zbmlbF9+1yTuZt3v8n6f+axH38/XjHFmDY623OK3BXHFyU6R2C6AB3wQkhEcU8dsH79nhtGZTVMoTIGxSmRSBMfhhBHMSjQmhEHOmJoSIxWkNrYMUAikURvhoo8lkUgRhjUqlgtYZ9uy9g1x2kjdev8Sl4WE2bMjS29tLtjWPV66gtSbScb8RRsU1FXHawuHLY5RKPmMjJQaHzdeHqvzL3Qc2n9Uyh28qKFw0DhgLSXhNvZfDNengTIgWBZBeLNgiRBsfW4ZEuoZSxd86/N5tn37+Jz+hVIHDH2gnl42dokwYkLRtWtIZtKkRBAEiEli2hZQJMJIQHz/y0DJEWiBkRE8iQUenw9SYYehSiatD8MTxC2zbCRt7XLrsJJmcg1ULKFYHSaS6+flP72/72l+daOvobMWYCkQCJQ01kWKwmGa4LMHJoqQk0BGWBGXqDmo0HOE0Ah+bKuAjTIhlfKSpUChOYspTUCmAqIIoYeQ4OTXBjh6HQ3s28PlfuJ/e7jSXB8coVCuMVMcYD3wujHuMTQeMXJ1gZFowMF2jUIE7tu/iMw++j49unaQ7uoDrncMfGMeOqtiWQEubKNCEVoSSmqylSBtBNDWGyLVQjSKuTNf40flRTp4aZLKaxJue5OrrIQ/e1cvdmzdz/MQzXAp6yaSzFIuTaAuwDUQVcGqEbgrTsY9vPD/Bh+87wMTQFZ45/QQ/eqPEmUI7oe9x4qWXyEcZXCGRlQIJBE4UYRuQOkJPj+MqH2kZqI2SjKpkk1AoXeW92zZz510f5t1XEnz7pUm+99Qb6MkhOtI2mzuhIwfdG9O0pXL0pXfTnXC4b98eBFANJU+eGOL3jv2IcZNnSoMX5hkbHgerA3AAB6elF6kdhLAxxsGIZNz+kZhG2zf1zo5ARuAbi4Ldy7lCmqEJzV2dCkdJiHx8f5rudpt77gr6Dt27icLEBVwLHAUJuxUpExijOH9ugoHBq3hl2NyT476+JLlWTS0cRVkBQTiMEElaWpKAJPIDtA7BgBAGS4G0bbAgihQ1H4LAZs8dCbb3WTz3/ARTlWf5xCc3f/o737/4W51d9v+GyKNMnIJXSRdMiCDEsDKBGhC70IlYKGSERiVcPGMgmaJn9/Y/ONN//uvF0tjvbW3n4awN3e0pHDeFlUpgtEEJiND1EyxxXZdarUa14lGr1XjxxFXyedi5cwt9fX2EYcjExAS1GrTm8ggDQgqkjIVpDcGYnOeeR4o4ZTg4hJGH1gIhHaQVQuQRGh836XPXns3OwNWzv61D/18bMesl1mgKMx+dOAGqXGGaS7GUFgveLOxaQ25K+Wta/3U5F33E91SHeWct8jn+VldgAY4QPzBfy3Ftnnhu5je4eW7Ecx1p4Fo3mrVktY5/i6UIvZVpYbbPHqY5D9Jk7Vhu23+c+QVub5cMBn3E/ecIq6tzvn6s/tVWaAGOMP/C7y8Bv8vNW9y81sLDFuZPTfxvidPPHmH9hGo36vjfyOBymOb8U5MmTZqsmqZArUmTJk1WxsOsryPUfDRFak2W4jBLD6xOEA+kDrD4pPND9X1WMxC8WeK0BuspUusnnsRdrUvRjXD0Jpb1dqYxmXS7pqBp0mQxjrD0g4jH6z+Xuj58njju9K+iPjdLnNagKVK7xTAWfPexHyTv2MlvbtuSpzI1grQsZDJJYBShicUbQgiUUqSSWXQkEDJ2MgOQ0sIoia67qMl6ujqpJGgIaz5CCIYuX2XPvq34vk9PTw89m7bywgsvMDRQZPD8a3R3t5JOpYl0VBd2Kgglvu9RqU1Sq4U4VpLO9m1cnLrCwPnJz9z94d1e1Ui8ssG202itkMYgRIAwui5ikIBePPPfm06MBKNRogQifj9CQ1TBwmB0ta2zxf0P1ekRXAX3vj9BMj2Nm0iQTNhI2lAmwvdGqNQCQh8SFmBnsZREYwEWlrIwVIl0FUEEMsKIGvn2JJ3d3dT2wIVzV3nlJJx61ePQIY+dd27ESU5gnBq1WpVLF0+zsQfcpMKYAOqucx5pTl1OMG56yLRspRDYBIEHItZpVf0KoQzBdUimIKUCjDdJUBzGK45SqU0AU5AMIFkFJyTTeSeu1mStaXqp8T880M3PHurBbbvI9NnXuDttE7khfqePLwTRTheMS63chszs5I3KJv74K09SNRUsK2I6qtGWtuloaUOWa0RTBURUg8igtUZbIC2FpaEauOhMH89dTfCdVz0efXqQyyaLzw6UdugfCnnqUoE/e+oSvYkJTl91yX/4EKOhR2SpuvowAOODFVCOJD13f4xvPvUME184jShVuDhm4cleqspFy5D/9Rtn+NOnJvjg3Zv4qXft5n3bNDK6SkIFYFcojl/ESoOVFJRNEZ1MMTZdRNEFYQfFgk0YZsAYNiQVv/Mz93B4T4qUGSCfrFGcniSfSuOEBfzpEDM8AlLgKp/Du1y2/s52vvzYKX541kFs2MZguYI/fRYiCRWBf/YEWK2QakMm2sl27cBKdeJFDkGhApUAbIWyXCxpzfSHkpUhl+riavFlfBKgiwhTI+lYtOWTdCYDgkIB1QuZPARBgGVrXn31MmfPRkxMQe8W2PeBLRhTxnGKKKdKygWpIOW4KOViQkEYhBhjCIII3w/RWmNLBSLEKEMiYZNIpMmmMkxPXqWjs4d3v8fm2ReuUpke4v57Wv/D975//o/v3Lt9wpcRCAuEF7sjEqLNytJVCmNQJsQirMcGie0mqAYaYSSWSLH/3e89e/zbP/6spanu3JTl0uUyOqqg5RRC2eRzGeYKj6IwpFarUfE8Ah927eykpaWFtrYWPM+Pt5U9AJRlgY6urVPdgVIbg9Jx2mQwsXBNEKdPNhHK2IREGGScElRYSB2B8NnQnWFnX/43H/v2d/9dZPCia8TEcV0brpJaSOpFxHWqq74Wck67XhQ2I/+tO5HpZQu6Gvs1HNAWet91zm7XOZ7NiOtmHDBvUAS2YgHayuq/RjRELYd5+4gJbneOsPbCtPn4PLPj6LUWi8HCD/4fqpc9UC9/vR1ylis8WChF6K0o1DzMrCjtRvrt9HpUpslty1q0/RZu3TF6C/Gc9VrO8faxPgK1PhZ/BvVvmY0Ja3W+B5j/OrTW9wpfXOSYjbmeR1j7Z2ELCeOWojn/1KRJkyZrRFOg1qRJkyY3zgFWfmPcyF/fwspu6tc69WKT24sji2z7Wn373AHUQjbWc7cvdsyl6rJScVpDRNfHjU/M5oknQg+w9oPFo9w8gVrTPW1x+ojb58M0Vwk3eWfz8CLb/pA4bs2NhUdZ3A3yYVbuyLYacVpDRNfHjffp/ayd+1uTVaAFBNqnUOHzGzcmXd+7ijKAsdBItBGAREiDEhLbdmaFY9ehpI2pp8ozUmOMQBHvJ4Qgl8tRKExRKXtYtkRKSehr3v/+hxgfG+PK8BXGxsYpFsvoSGOMQaGwZYpkMkFnRzfptEs61YEybbx2sjj4jz/7Ye/EyBtg9IxQQmqN1RAFCD0jYFiOfuVa97SGiMNnVmQQYkwVARitP6SooEN4111ZHKdEygUlqxitCX0PPwJpJ/EqAZUKSAFXrhTBFGeK8SPIZqG1Pf6Zy2fIdqQIAs3kxCRGwq47W+ndDOfPTfL4cRgdv8I9DyRJJzPk2zo5deoMFQ+QZaxEhIhi3YsXJhmcylJUW9AiDYCTSuCPjzFdC8nlUzgtESXvCtWRYarlURgbgCSQtUi3CkJpaN/YgnKTlKdGsaqvYFVGObg3zS++fy8/u8VGjD5P5fIwjqqS0BZG+jjKQwtIuG34Oo3TupfXhsd59vl+JiemeHlwkJOnT9AWneOuXov33bWVA9s62Nq5C1EdR4pa7DynfdJuC77vMjAl+MFTF/lvPxnjheEUya33MqUtEBYy0kgDIZ1M1QKGRqfp2HYHBZ0giIL45KPrOVxlbCtlHMY9hzC/iydfOEHP1t1MK0EgLSLpY2wD29oZ8Iv86dPDfO+pfg7vNHzynk28Z2cvyfAq7Rvu5MLl07S091BzMpSiPMVKhgtvlHjpjVP8+PwPuVCymRIbSAqPnzw3yY70Jj56fxu10Qu0yALhSBGMheu0gEoT6gjDNArYmWvht3/5Hr7yxAT/5VuPYesc2Q13Uq64dG7twR/3qBZ9CoUB9NgA02YMfAvcNqyWDVhKQeRgZBJhJAlsQuNQM2l80UqhovACC2FCbAyCENdyyKagUiyxsacXVBG7Bk8+Mcbrp2HffsGBe1oJKSPUBFIGWK4glUyTTKWYmpimf8BjYsJDaAhDCAMwITg2pNPQ1pYik2mhVqsyWS6TyXkku3J0dmYolcdw7AT3H+zm9LmrDAxO0tXBB91E9Nc6qGKExEJjhL8qhysJ2CbENrHTotQydoM0su5wCC3dfXzq0znv9ee+e/GOuw5u1qUJitOTjE+XkVLg+/41x/Q8j3TKpbOzk1Q6Ta4lj1IKy5JEOsKr+oRRRCZjYUy0QGBqpNc0zGceK4RCCI1QEkOEkSDDBMYEBLUylnLZ0tPuvnFh+kg55D9HYo5ArR7LDHrm99mNmuVFyhvhOiHXTWe15c89Rzd6jIaz3vXccF0a6dEfZvnCnSY3hz7iecab+b3kga+y9mnLlvPgfyvwIvBLrP8i3NWKZFa7cHO19HGtmHSlwqHmPHKTG2W1bb8xP3CrsdRc+Eo5zPp83uXE54dY2zmRftZ/rrWPpefYG07/a/ksbKXitAb7ia9bi83FNWnSpEmTJWgK1Jo0adLkxjnGjQ1ivszCFvYHiAcPR27gmI8CB4QQU1JKtF6/VBdN3nYcXuD1rzH/wOmLxIPOr97g8ZaijxsTOEwT96tjzD/gbKSFWK44bCvrM1jsZ2kXta+x9GfvY2kHxqPLrdTbFSnjBypRFC2x5wwtzK7yXs+J+xM0nSqbvH1YyDlwoQdNR4kf0HxhgfetVKDWwo3dHw3U93+UN8f9ualqlhv3P088yXhsqR0b6VEbqc+arC1GQmsn/2NndxrH8TGBjUHFAjVRT/8mBJZlY1kKgQDETDo6IUT8X0qUtNA6whhmXNSEkBgR0dqaZ3R0gvGJcbq6OnDdBGFQpVgcI5uz6ezeTaVSwZjYOcsYgyUsbJFCSEMki0SETI4UCD3D5MT0M7a0URosHc58HikaTmkaI8AxhkgaQCyZEu4a2YAQCCNmnYSExugIiUYYg4SsFLC1L0lXl0WhGAvqpFT4QUTJm8CvulwZ1pw4CcUSbN4KuXy9oLpOSkmYKMDIGEQBJFMltm8P2bCpjVQ6SToDU1OTpGSGe+7bwMaeSX70oxoj41UOf6QHbVlMVyGVBztRJZnShB54NSj7Lhcnk9TUJoRIxp9RStp7e3GmikyMnqZ27klwJkEBysDmDKQSpHIuUjkkanmqhRDGq9jlCbrla/yTT+zh7x/qoVOMUhkfI50wpFwH3w8IQoUjEsgoqAteDEXRxvdfMnzhr5/j5GWBbt2KbulC6JBKrYuh85N887Vp2rPn2b+zg74uxX17+tjS7dKShWfOXeZbT43w5MtFLkym0KltqLYkhVoVnDQQomWcPjJlMlT8EOwk2Q0bKdVq8fen6gI1GTd6QQpLS6KwSqY1RSnpMD41hnE7CSRoCZgaRDWQgrClj0ndx9+8eoln+n32bR3mp+/r4IN2OzLbzsmRLC9c9HjytSnODFUYGxdg5ch1bmBSTBBaCUjk+IvTY3z1haf4/Id7+dWP7mZL7RzCKxDJGgnlIUhjhEQLsHVItlbBGn2Vf/aBXg5u3MaXvn2GFy+fJJG8j6HLI7iZBHQIcl0JLGNRmDhPWJmGEZ9wLEdo8mTyO3A23I2VyGFKFlI7hJGFMGkmpgNK1RDHliQlCB1hWRLHtRmZDCDbycAbQxx/zJBJwvsfVKRSNtlcDaMMxlTp6NqEVxP0X7jCmTdKRAaMAaXiNm4MBD4QQRSCV4VioUS1WuKjH2kll2unVBjD9wbZ1NMGJqBS0aTzXXS1ZThxsgSGrO8HsYuYjvtjY0y9Evc0iN3AEpHGMXF6TgwIrHpqVEkoNRUdYESAZ8JnhkYvbd6YSdC9oZUdd2zFCPC92kwdBAqpYlFu43plAG0iwiiOUZVKCd+Hnp42ImNQQqBFvVkK4rKNrNdHomUsnNVx2I3rrRQQIbQgUgEYg9IuUjt43iR20mVrbxuJxPnfMDX+s2ZWUKxRcVmAMkE97jVcyHRdyLkIZnFxlbwuxuqZw61m/mOuyOz641znqHbD5S9HLLbGaULNnNfFokd/RK/Pw/gma8MR4vvvt+r7+Q3i++8ja3S8R1n+g/+1Fh7Mx2pFMmud0m65NMZlzQV5C/Mws8LbfuKx4PG3rDa3H8tp+8dZeH7ureo7C7EermnXH389OLzM/T5PHEtXuuBwuRxmbfrZctPIrvVC9GOs3gnuZ4njz3o4kDZp0qTJO4KmQK3J7cjj3JzByPEbeKje5PbhKMu/if0yi6TK0lojhHhJCNFYufMIi7uaNNgKHK2/r0mTuSw0cbVYW3mUWFQ1n8hhpRNhx1je5Oo08cD5iyw+yGwIPI/W911OKsf1GiweZfHJjOVMfi41WbCke9oaXX9+dy0OshqklMv5LAdHdk2UAAAgAElEQVSYdUtbr0n7AeK2coxlTI43r//vSN7y/jIPi03oHV1kW2Nl7Xz3M8udJJzvmMu5P5pmNpYvxBTXxv1jLE+U+kXi+Nu/jH2brABJrDsSov7gvv6z8cw+YeD3/91X3v2vfr1jT2d7K6XCOCmVAmmDsTBaIqRCWRLbchA4byrDGEP8T2KkwEgBKAwag0DrCCEEmWyGKIJisUh3dzeOY1FVYNsOkQ4oFKaQUmJZFpZlxeI3bWGikCCoEcgpQqPJdnby2qvjDE4Uvl82IbF3mjWTsk7VBRSCOAuiMjYNbeP14oVF0XVBE1FdDBMCBq3rrkaGE8JA76YeitMXaGl1CXSAEDahjqj5IaVKyPeOe2zdAvsOtNLW4dLR4cbpCYWPkAK0Q80zVEqaWtXjyvA0L7/qceq1y2zqgbvuytHS0kpY00xOjJPO2HzsY62cfmOSr/71EIc+qAkj2NwDlvJJOJKoCsIkqHkuIe2EIkdCeLjGp1qtMH5pEDE2iBOe4UPvdVHWNMqy0EpQjMpMVWtMlSt4FQ01B69s2Ni5mUMHD/Brn/1HdEZnsavnqYUlLDdFBR8ThLEoSUhq0sEIh5pMUQw6+PPHL/FHPzjFZbYRZnuIShoiSLX3UKiVSOa2UvOLWGn4wYUrVJ/rJ/O3r3H/u3Zw6J6dPPnsFM+fdSjJfYStXVjJJEoWMcZH61l3NGkkKqyB75HbuYVpC2raQKBjxZnQcSMwEssoLAQh4KSTpHp7qJwfIpFsR6LR6FhIIlScs9LKUI0cItvhbLnCGy9e4vnX36D6c/dSLQZ86Zs/YMruxs9uxbc78BNJwrDK6NgEhiSWVGiTwEtuwbjt/D+Pv8y5M8P8zj98H1tSeRwxRqVWxJVlHEcRSYmRLlKlyThpiuMj3NWzid/6pw9w/HTAXz85gle+ii6OYVkeCTRJBLtakrRuzmCpBH5xEumHDE8VefXCGwRhNx0992EnOklgoSLBdFlRqKVosxwcK8SEIZEOYoFcAs6+dpHnnzN0dMO77uogqk0jhIeJbFKpJKG2ePaZiwxchCCEjnbIpKG1rYV0Lk0qZRNGEUFNoXUsOJ6cmGZ4eIKpKfjzv5jk7/09xV37uqh6IyB88i02phYxMT5Ge+dGMrkzXDjFCTdTIZlOI0UsqVL42IBqDEnEjfl/JUwsbrVNXSRkJAIZxz7iFL9eoUprPk1hku8Xpiv/YGtbmoQrkUIQBGEsxJVyplxjIrSOiCLQGKS06gJejdGCWi0gCiGTSWGkRqMQIg43ui6Mmy8USRPXr1GQFIpIWghh119PIGSEjiSh75N0XHb2uHeOTnsPaGpPR3XRoxEQzbRvTSQFhlmBr5jPsm0OUl6fcnOxvfWbxIP6TYfXi4verhF36TfF8Jtd/ptYrHyxkINa/FqAjusz/zGOcfNcwJvcOF9k5c7za0mjjRxZ5XGOcGOLyfLEbXSlY5Dl8HYU2dwq7eJWpYU3p5BtpI+9Ga587xQOs7pnbAe4dQQ8q3XNWg7rFcdupM5Hidv/aoVca52RZD5u5HxtZdb5bjUcZnnPFJZDY/7pZpyrJk2aNLntaArUmtyOHKd+s1KtVhfdcbXOCU0HhnccfSxPQDYNHKlUKm8ahAkhkFLO/J/z+hRxu20IJOYdfAghUPFK6t/QWj8qhDieTCbnrUSlUllGVZvcRvQt8HojrexivMTCA7QbTYdwhOVNSJ6o73sjK2X7mXVTO8bSYqVjxOdlLQeL/SzuoraV+HMdW+QYR5Yo4+hS168Gq7z+HF1ow3pcP+fGv7kPrFKp1Hy7N1ZwH2H9JpCmmY25x+duWCp+Nq//70iONn65ha6vCz0seZyl495x5u9bKxGBHmZ5Dz5PAA9Xq9X+xXa67r6mv378R1jY9a1BHjiWSqUOX79hrotWGIbXvN5k+Sjgt37zp0gwgRAeyoTYRqEiBxWlUKLA0OAr/6KvLYn2BIY2QpUD4aK1jUAhhIXCQhgHIcTMdyAMc5xg4u9GCgshIwIdYKRE69gdyFIKC0kqDZWyhxCC6elppLQIQ40QEsdOEemIwJ/9niUmFpwJQIQYBeeuDjFYrJLZkfnmZX+ay+NT14gQGvG+4TokyWBfo1Fe3DFHCzAmbnvGBGhRxZhwxknNYBEZgSZ4cfgKY9rLdIRVh5GoSm9flvHJkJAMVjLB3/7NEPccgve+910kXJ8rw4NIS1ApV+K6CYGyJEYI3LRNOmuxeXuC8fERBs7DhfMwPFTgvoMd9NzZTcQgOowoFibZvctlQ0+Cx759BTsB9+7NgSkwOQYJS+FYLYyM1lDk2NTZwQuvHUfaHro0DuWzvP8Ozb/59Q+xb6tHMkxihT7FcokrpSoi0U7kt1Cq+EyUapREJy8NJJnyAp54bpy2VIrN2V46Ui10ZSwS4ShZGZFMlAn8iAlPYLLbeG5Q8n/85ctcDXsopHoxYRJhLKy0izaGcGoaJSSVyjQIHz9wqFRTJHMH2LCpj013vRu3dxf3pAt07p1kZGqaF155kanxYULKdGxqo6ZiIVDgB2jPQxuDzDsUcwKTicATYFQsUpMSrFjaFPiaIDRgG6ZMRFvHBirnR6gVpklnWzBaE3k13JYc3sQEhCVUqgXpCO688x7u2vN5ejo68VyNMAGHnL/Pk88/S3F6AiHAtX20pbHsHKWyJvQhmXIwYUQUCCpiC89cLfPZLzzHZz50B597aD896WGCiTNkky5FXEqk0KkNFKspip7D9JTLq+cuEiXb2N5a4h8cvoNk1dCd8mhPJ3B0je5cFoykqjJok2Jv314ulS3+5X/6Kl/53vcYO/MsZO4AZyMtnRFjVZeRos2OXCuWDgiCEKVsdt2xheNPvsZ/+5sxHnhAsW1HB0FQIJtKoxCkMxmmJio88cQ4kwXYvB2274TOzgxC2IyNVDHaZmxsmra2brxqgGVJEqkqbnaSvZuSpJwWNnRd4YUXI1KpEXbvylGcKpDNOdghtLgtlNPtmNT5UScVveQmMpgoUe87IUIU+MB9CTBzUlhe7wB2nfioIWiSxCl8p8YuIQxIY2G0AuNgIpt46lWzb+dWSheHEGX+dnRoCnZ2U/VrlAoG101hOQ4YSYTG6MZ1S8XxUFpIUmAiJB52UlEsFmltS2C7NkbWg6iSaCVAxEk3ZV2o1nBWi+PSHPcwAUYKpHbQugV0iBEGIwOUSiGCEEvU2L25k9Hxi7+Z27j1M2EiRTkMsZI2iBBlfCSawcGrYN4sPG4Is+TM/f8KXMRm3CxnmTf6LigQW24qzAXq9laXvwQ2KSIJvNld/xi3iThtgTHjsllqfLvQvNpalb8Ax7i1vp8FRWpLnZ85rMS5Z38ymTzCInMoqxx/HahWq4uKZJb4fDdbZHPbidOWaj/Lnf+qs5TQqJGt4NiNHHQxVtv/b6H5g9uSZcSnlYrTpuvve4nZVLu3uhNpnrURci32nGC1rpQr5RGWXuC+nGOsFVuBR5LJ5NHFdmr2/yZNmjSZn6ZArUmTVdB8qPWO4+gy9pkmfpC6pOhm5oHctSuLX2J2hdKiAychxFFWnoKxye1H3wKvL2fg1r/EcW9ERHZ0GfucIG67Kx1UPspsP1lscmCtBubXc5TFJ5IfYeHJsCMsXucl3dPg9rn+zOOscJj4HK3nRP3XmE0tuCJul/Pf5B3NWgp3jy1jny8Tx8aVlttI//Moi8fQh1hipfdcUVSTG0MANgUcJlBUUIToao18uoNaeYJLA4Otd9/Np/OOxIQCRBIt3LqDmkRqC6USSOGAEbETWcNRZs5DfaPjfJWaqC4Wi3/XApDx96csSS6Xo1gqUC5VyWbyaNO4rgiiyKCUTcJxZq81EUR+RFgvUgtwUjmePzX07EMffnDQCIdIXOs6JOrp7BpOOXMy49GQvS11zsBgdIQWBiM0Bk1ErHILRZwAMBLShOgfh2HqU+lMNzU1SMmr4WbauTxc5umnx3jvB2zu3reLamWEQIdcvlxhYLBC4MPUZGzOBbFuqneTw67d2/DDEVJpizv3arwKPPuU5nvfH+Nn0hbpbAbhlKj5oG2LjS0baM9PoyWkEimkKZJ0DGgbI1NUI8NPTj9LKVGCZJWEmGDrxiIP7c3ya5/azs7sGdzpi1jhOIQ1MkqyMZsg1KPIhIvZ0MGUtYEzhTx/ffwnPHmqgG/lSbrQnpwinyixqSVNh6qxu12zvTtPLteB27qNv/zKy/zdC6OcK3dDqgMnkyGZSSGEIAii2H3KmNitKwITSYq+Yf+7DvOeBw6zrXcPkxMe4x6ojMMd7Ya9dsjOHXcxMjrIQP/r9A9doDh9NU7DiQLbIZwaJv+uOwk3tlGuFkAqpAZlBFJaREoSRSGmVgO/BiqJNoLIcqC1FcanKXs1RC4LY0U8T5BOttC1sYvOzm62b7uT9tZNdHVsQ8kkQ8OjdG/o5MCD72HnwY/z42ePc/LkcwwPnSORdTEY8vl2DFCr1pBSIEjhIZk07QQJh//01df50fEX+ZVP7Wd71w4Kl0d4/eo4I9VxLk8NMl5UjI8ZpoqGWqSQSQcnY9HXk+SffOwAiclX6aCAKI2DN4CWNhWdJRAO0/2vknLb+D//50M8cLCNL3+rnxMDL0B5M4PViNC7xNC+TThbcwSVIbQGqcRMP9+3T9DV1QXCw007EAlaWrsZvTrBt749DgIOH+4k0yJwk1AulUgkJNNTHhcueCSSMDpSIp+NO5ftQjIHBw86VMplduzsQTDEyyehd6OmrTUBKFxbEEUOl4bH6R+IftzaahnbThAFM5ItIBZiIWoz/Xc2meU1HXqGhgNXLEoDQSPnbhwbZhy56j/9ik9r2wY+8NCHB187+cSzE9O1+/MpgWOpOJ2xcGKjPanilL1CIKRACkEUSQgshLSIjEehUKBWq5HNpjGECARGWmhloYTCSIXQKg4IUtRj2dx4JWfqJoSFECZ2BjQKjA9G4thJtO8jwojWtEvO5tOnT5z7tT3v2TWZdhL4JgR8pKzEwjqp6ylNrxNJ1b9/sZBA7fq0latizrGuEYs1Uq8uELPnOpStqj7rWL659vo0t6xo/rc8wq0lfmpyLce48e9ngPge9zizizjmW0Q7QHzPvZKFXqtJEXeElYs3jtJ0vYL4O72txGnrwCMs3ba/RNxHjq93ZZosOl/cd7MqsQTHuLF4OMD8MWk+577rt98KrIWQazHeqs+52jn+FtbOPa3BEdb+mUOTJk2avCNoCtSaNGnSZHn0sfTk0bLFaUswxTJEakKIJR/CNnlHcXyB15czCF/MVvtG2vMRlk4LulpxWoO5Ys7FJkHXY2Dez8JpUSE+54eZ/ztZarXW0RXW6W1Hw1HtOqaIVyWuNSeI28GjNO3Xm9z+9C1jn8NrVNYRlhf3VyNOa3CcOD78YIn9jrLI55NSzripNVkJ9QfkxqqLLoJ6qkMfJL+2a/cOYbuKKDA4to20FRiJQc3EfSXi1J1GG6SJXTW1rAvTrhEuxGUZQfxg3kgsK0GtVsV1JZ2d7Vy9WmBicoK2tg6q1SpCqBnH4Wsc2urCCNFIbWcsMDaD/SPoiD9JOEmw3BmB20KohuRsRqU2/74zgrb6TyMFQhgioYmERtdd1SJhiIirE2p+7+SZs5/auzNNsjVPwSuQz1sMDRcoVGHHro1cuTpIwnY4/dwEVQ/yrbCjz+JUNWR0FPYfhMlJuDToc/7c69xzIEs255DKKLQp8b6HXF583uPP/+swP/tz3XT3Ktw0BL4h4dokkxIijaU0IjIopQhCRakWMl4dp5TUqDv2srF9M+nyNB/adIV/9rGt9KmXcUbHkX4AMgQ7jFNZ6hBL2ZRVjcGyz8lSjn/9R48xUE1h2rajI0VJRkyYBMlqJ68XFSkt+fYLk1TGprj/voO8+8Gf5ry6j853GaLJYUp+hXK5RLFQRUcRCBN/12FAKpfDUgk2b9zJnjvuYd++/VTKHufODuD7IVIkAUkU1IiigGQqw67t72b/3vdxrv8sE5VJXj/7GhOjV8jlXS6qfqpa4BeLkElCyUOY2I2KUOPUNNoYPMsCJcCyoVJDOi7p7k5UrpX9d+7l1VdO0dG3m01dW9nQ0UtXZy+um6FQKBAGhqGhi2itCUNN7WIR20oQ6YB9ex5gc8+dnDt3hqee+QHV8jBKacLQ4JWrEBlQNspOk3GzdOa7Sbftob01zcteJ8+fmeDPvvJlRKaDUFmESKTlYjkuMquooXHSSSaLJf79nz/PK6+/zm/9w0PkbXApEIkEAI6uIfHi/h5MUbvQz2cO7qQz1cPv//nLeB13U54OMOcFw2OThEEeHcT90ACYACkglTXkOyRSgFI2ttvK1aslvvOdETb1wq49OVpbs0xPGMq1JBPjNqdODeHVoLUdejfaTIwGKAkbN0HFg0sX4YnxaXZsb2HDJrjv/h1cGjjHiydK/NQndzL0xlksoUi1OJz8/hkin99v7cgjdIRAEyf4jFOwvilt743k+IQ5AqJrhW8ITSShZFt4RiDsHG8MBX9yxxXv/tyuTpKuwQ88jLTRWDNhZa5ATkkohx7ptIvnGUZGx6lUfXp6u4kiTYTB/f/Ze/MgO477zvOTmVX1zr5PNK4GQYCXAPAQRUqkyJYsU7cEyZI8PiRCY8tje8YSNevdjd3Z2cFMhMdrT8SanogZ22t7DY1t2Za0IkTdh8mGDpLiCfAADxBA4+r7fncdmftHvdevu9H9jgYaB/m+ERVAv6rKzMrKzKr65Te/XzsaKqeJUP1NKguBhRR2aONplqvCqfAiRejZbGkREuSEhRQa7Aja9wg8TWtTMxv72sVLQ9O/HVXqDw0G3wBIlA5Dy7Jkb7rk+ov1InSxPstjvFjYX2P1LrsflS05z0/XCJaQokWFY6/I/IEl9beI5B1aCS95grZS/3fllyhbrENZIeVKV4u5GlEvefAQ5W/ZEgZYmZxWiksOEbaDvdRvu7m/mNdQHeeUzlsrthKW9XLZAVb6Tum/VIWgfpLeNyj321nCe36Y6t9nVzNqVUA6wJVDkLpaMVDDMVdK31kND1A7KWmOyguOZwnH4tXG0/VyfzhSZ9otlJ1HrmSsZf5sH2t/1lSLNc8V0z9YPHY/1eu9FheVBhpooIEGVkCDoNZAAw00UBv213DMPi6cnFZCiaRxmMoBwf00VNQaqI79rN6G+6luOVlPPpUwR9iuLxZB6DBh2R+qcMx6qag9SOUgxwOcT1AboPLHbU3qaW9wlKTzB7nw4M4pyoH8oQtMq4EGrkSs9s5RbYLnZlYPqh6pswz7q+wvTZJdrHF/EPgile0+GwT+9YaRQEhQs60IruviRGDHzubfi8UcdOAilIO0l4YbQps6idFmYS4+CAIsFVrCae0jpeI8dR2joKimJi0LndMIIWhubqZQgFQqhWVZRTKaCe00iwplWvsYXdI6U9gopJFgYqAtZqayBc/l76W0mJqeuWhVtGAJasCYkK4RGIfAtBKIAN8ERdtPs3C1Humf/uTJ8T9rat74O1taW3B9SOckw6OwaxekM7N0tnXz/e+dIBaBO+/spasrST7nYsvTvO32Fnbfen1olfjIaxx6pPDvjr+amrzuJv7v3btJ9GxoZX56jjvf3sVL0QmeenyMt71T0NzuEIs7WLbGESHJwcJAUU3OR5FxDfP5DDt3bWNUjpA/d4S9b+/k39x3HT2FF0kEeXKZSeyWXvACAtfD9fMoDE7fVobnFd8+kuJPD36f4WADVu8GXCXDyjEBgadI+4LOji0MHz1NS6Sfu95/L2+99V429N/AXdsFTlJQcKdJZcaYmZkklZ7l9OmTTE2PMz09AWi6uju47dY72Nh9PXOzBc6dmcH3fCzlYzsOktAq1rYi2FYEgSQ176E9xeZN27muXZLOTjE7cYbJ6QkSHa3Eu9sYy+dBgAwM+AHSsrEDyI5MEk0miHU2YzfHmZ+dA20IMCTbWpiYPcP45ASB55OanWP3u2+kKdGF9mNMTWSBaNgGTA4hJbat0IHG1S5K2cxMpXGcOLffdjd79uzmyMuHeP34i4AkuiFJJJakrbWLLRv76evbSnuik5iTRBTJnrPpaT7U9k6++Z2DpDNTSMsjEHkCHTZQYwFZHyLdYNn89OQof/A/fsLnf6Gf23p7sP0xbJPBwkVKn0KQoyWSIKJz5LPHuOfaa2n9rXfyh//jcfy0zbXX95POD5POuLRGohjyGDTCLyCATBacCBgTYMkIM1Mu3//uWTZthht29aDFDNncDJ7Xxk8eOZp59RW+mMvR9f4Pxf/gznfsRps82cxh5mZh967duMEc27dl+eY3JijkZok3eUiZYNNWOHsKhl4fxYgo8UQ3Lxwd4eQx/vvO/p6f+p4h8HJIWSLaarTQC/12jb0eYxYTXHWRvFsci6TE03kKBUFcSd7zvnf9xbnh5/+PbVs7N8UiBbwgQ0Qk0IDRQdGSWi+MEyDRgUDKBDqA+fkMhQLEYhGE9AmMRhSJuQiFlDZSWEgkUorQ/VOI5aPrAoSwQBjMsiMspdCBQmufvt4u3nJ96veiSv7hfCqPbcdAWCjjhBaYJQvllWAkNTPRLhVKamYXVcHtEuZf+bx6bMi+RPg+N7Ts98PFrR5iUwPVsZfqtvUllBZ5DC77vaTisxL2Ub6Xs4ST5gcox0RqaRctxXMGaiwnhNd1oaSoAS4fQe1KUIEaoPY6/AbhPR1a9vssYR2+kVXYah3btlI5FtrAGx/1kLVrXUw9uPbirBkPUraurRXrSVC7WApqBwnjtvU8O7YSxrPWMv9WaXE+hHU2WPz/QcqKpdVi01cDGbCBBhpo4IpDZT+KBhpooIEGoLzqsBJKq9YuJoaoThy6lytjRVIDVwYOrfL7A6wcXCwFNlcL8HyjjrwHqP5RuZ+LTxQ6CPxplWP2XeQ8IfxIXa2+ISSv9ddZjv1rLs0bCyUVyS+t8fw/BW4hrP8HaZDTGnjjYpYwoLcSDrByAK6fysGzegJ9tUxE7ePiqxY+SOXxt5RvA+sAqYvkNB0F42C0ImpbvPzK6AeaWtQGqYpqLlIiZaiOpqTEsWxs2ymSccoKdhpRVBdTBEYgipZ2QhQ3VNHiTiFEaFHXlGwhIEBYgo5uBcLCdV2klNiWHW62TSQSIZFIEovHUJZCa01TvJl0Ok82oxkdnmNkOPfQx/e+N51J59m4cSOyaKe32laCMMWN1TdZsv0zoDQQJAm8a3Dd3fiFPXiFPfjuzQReuPneDbzj3o/+7rceOfflp56bREW3Mp+Okk5Dd3crfT0beeHwSaIKbru9mVgSZqYynHh9nJFzkEsLJkYLjI/4vHa08LV9v37Hf/YKiMwcvHAYzp6ap6tzI37gsn1HJ14Ah580+Nk4ltRof4ZkHGI2KOMjMfgaAmGR04rJyWnM1Dgb8yf5o1/q5T99uIPO7EliJgd2ltjmOCRn8NUUblBAqBhORxdjfgf/7VGP/+uhGbKRG4k1bcIEBoEHlgbtgS/AlUy+/Apxy+ITH/4ov/6pT9PR1MHE2WHmzp7h9NFTDJ9IMT8eRQS9NMev4Z67PsIH3/cv+NhHP4OSSTCSubk55ufnEUIQj8VpamoiEokQ+D6u62JZimg0irIUtmXT0d6BpWyefvZx/vJv/oAf/+AvmMscI/P6U6g2wUwhHfrn5Ty0a9CexnI1ViGAYycpzKfxXZf5sXHwPECT9XLMFzIIR/Hq44+Tmp1hYvgMf/b//Bd++MhDZHLTdHW3EY0mEcTQQQJhEggiRKNxIpEYQRDQ3NxMNOqgLInn+XgFm/lZuOn6u/jsZ77Ie3/hV7jzrR+mf8vb8N1OxqYUp0aznJyaYmhqDG0Lbr/zDv7tv/mfeNvNt2K8SZpieSKWSzLhEItGQdlgG3BiTDsbOPjcHL//t0/yndc9gmQ7BS9FJj9JJC5pchy8TA7t+ZhCmnh+hHs2uvz1527hvV1jTJ87Rto1pPIugRFYUoRtyRTYvAHm5qCpKYGWeWJxm6d/foqYBddd14sfpEgkIpw9O8PhZ08gQz6T+Nje6//zU09kv37udIrxEZem2GZOvA5PPXmUyYl5otEEez96E/jw2tEMSjhs7OvBKMgbm0jTZp58cZqD307//dbN3f9a+hGiwsImwBIFLFFAiQDbiFDZjfImRG2bFKI4PoUwJgDhg/ARsoCwXKTK0RpXtMYNiZjPI4OPdk9PzwzlPJ+060LExnVdtO+HY0xRAVLrAGM0xmgSiSS5XJburk24BU0yGRL+hBAYHZZBoM5TKJaYYhkFUkvCo0RZ8c3I8BchkCoct01xHJZKhb+h6WxO0NOe3PD0Y0c/0BaPo7REBRZ24KACB1VMo7yp8rZEua2BNUHopVtl1KpIfQtLCU3LcaUqT99MWTVqPazG9hN+7++7yOn2U/sk9n+krGK3GK2srmz3WVaPSz5I+I09V2P+pQUfteJiqKDXk99yXCnWeheCWuvws8Vjh1bZf6X320Eu3f3ad4nyWW+0Eo4dg1Qn2TRQxj5qIzTW4/RxOfrXAeqPj15sK8vFuJhtcC+1P5cWn7MWVCp3yUJ7MWapTbHxo7wxnkENNNBAA5cUDQW1BhpoYE3QWmNZax9ChBAEQXARS7SuqGX1aa0S40DZZqgGHCSchK20anUvYbCpgRpxtbffCuU/yMptpYXQEq1k21EiAD1A5bZdD+lyX5X9JTWr9cB+Kgcelqywuoj3bz+VreZK5YLqNsFvGvU0rTVKqWqHzVJWpax1hXkJAzTGxAZWwYWO/5cbK5R/tRXyLcBzhITNQcrKrPuoPO4fqCP/fVWKe4j1U0HYB5yssP9+VrAVvdzP7zcKQpKaBAPa5JiemaKnly90diURwiCVwrLK47wQq6+L09oghUILyrarCyo8QflvE5LTSjDGIA0kojGmJuaK9p4CN3CLearicQWUUkQiEZx4hOHTw9iRCCjFuTNnSc3z94W8IRKJkUqlqm3AkggAACAASURBVF77edawNVjFCmMQ2mCMIjCteKYJs4LNrCcs5gsd3DXwgV/77ve/c2Rk/Pk/uPGG7VZbG2TSHplkgbk5QzwBmzfuYHT0HC8dGeH0KbAi4Hp5HvvpYSJOglSKl77zrZ//l098Yufvb9zcxOEjz/DkE5qm+CxRxybiuLxlt+T4K5rhc3NsTUTBaLwCJBOhbppvDNo3BEZRMApPW0hf8Wu/9CvctrNAzj1DU8ct5L1pZr0JvNws2ssRc+Ioq5WMG8UNevjjLz3Ow6+2MsN2dEZBLMCJCRwD2vVQVgytLdyMS0/3Tn7jV36DjpY+Xjj6Okom8HyFbwzGyPBCLRZUrzKZLLaj+e73HmZs/CwjZ1O89OTPadtwLXt23cEN1+/CthwsGSebyZHPadLpDLGITTIZw7IVr594kSPPPscrL/0EmqchZuNnM7BpA54EryT8FBgwGksovJkUNooPffZf8q1vfgMvKqC1CTwfgSAIfJCQaG9hPjKMTmdoam0l5c7z5A+/xdNPPs89d7+fO9/27pC8k7dIpVLEYhbT6VkSiRg9vV1k8hnGxs7y8mMvcvTlwxSyszjJJD/44fdoSraxY8fNzM/lGZ9PYYSDFDYIHy3zSJEnk4HUXJq2ZCuf2PsvaGkx/PDRb+IBQlp4CnALocestPB1O6J1N6/ODvF//tVjzH/4Gt6zZye2nUWJOHOFArYTRzVHEZEk2YygEDTT1tbCZ37tM0z+02OMnj5K3u8gk8sSbbZAa0SQRxmwJKSzBbTv8OorZ5ifgdtu7UfZWXztkU4FPPE4XHctvPPuuxJ7ds/+xVe/8tIO1+PFsdGZj4+MDdO7IUE8DoOP+LxzYIadO9tpa+2ko1ORzgUERpDJgxOF4fGApw8f8599ln/3mU/v/ePHf/wilpEIkUVJSYBb7MYWGpYoqJllf1fo4ZTGJmM0mJJNpkEpQPh42kV7AXp+lEODT+xtb+PX33335o/NTc7IoaEhdu3uI+/7xB0LiViwjjQqtEQOW7skk5knCEDKFLaMYLdEkArwQUoLhSpeh8RQVjMzZpGUI2XyWxkSIQ3oIjlNiIWhTaBQUuIHAfncLO3NCXo7Zr7gFdzvKBMBU7T4lCW1t1WqyYRsXVO05C26itYFYco2m1XtNaudX//plz1/FqmPCpbq0enzK36ghhT/I9UXJhxmfSe514J+lhK09lNnPK4KHqT8bl2KIVwsp4QDVI8tltSHV8qzRPBZaYHIZ6lOfjtMWWW4FtLGfmonjdVjWboa9hBO8q+FAPJGIO3Ucg3foPp9Xq3++uspzEXGcmLlQdZOSKxHcelyW8deLCyO9R4kbCtXKhHxSsK+Go/by5Vfn/sIY8YrWTuvhrUqjV1KlJ5LB6jdRWOt432l84ZW+X2Q6vNycHkVQBtooIEGrkpcvbMzDTTQwGWDMWaBYFUH0WoBiwOi503yXJkYqLJ/zcSSGutvP5VJMPtokDFqxtXefquU/wCVbRvup/bA4Rz1fVwNVNm/v4606sUsYR+o9KG+D3jgIt+/QSp/qO6lHGDdVyWt/RdamKsBi9tvjXiQMGBRSelvOfYUz3mAhsx6A4twoeP/5cYq5V88ibYSvlBl/2KstGq0Uv7VJiz315jvWjBE+P5V6Zk2wKLn2OV+fr/hYEJrPMeOcvLkaN+e3dH7urqbEbhIqVAq3C8XtRkhS3JDRTJHaaJeiAUSW5mkZirO4JeUyXq7uzl7Ks0Tjz1DS0uMQsEL96MItEYHBiEkjmPjWBE6WrvpiMYQQpBOBcMf+8hHvzUfWMzn08RaosW2Xc54eVPRywiOtYwlxpSVbgICjNDhtszuzmChVRc5Hwbe/f4//t53vvuV8eFjn/dcfjmZyPRt7pNs2QavHYV//IdnzrpZ7O397T1trdO09cCNN27m1WOneP21DBs28r+3tWF39vpkvdPccecOsrljvPpKmut2JmhtsejuaWbs3CxnThs2bPXxAo9cDvp6YwSBRhvQBPjG4GmLgo5gJzfxz8/P8c1Hj5EkTbPwSEYCYrEYCdvmmp4oOpcj0DaBvYF/fmacx15oJtq8iSY7zpydB+XhFXwsT6BQ5EfHUK0buGXXOxm48yOISDsvnTxLW3s7+ZxHYDSBb4V1bXIY4yGEh1AFZubH+MGPDjJ26lVEPAa2QkbizKZOM/joCV5+7edcs+16dm7bTWtLL/FYDCEUXiHFfGqco68c5smnfkYwMUbrNX14WmIIyM5M0d6/jbRwFtppyDoKsO0o2bFpjBPnffe9j0PPPEkqOwOeRskyCUULsBwHZ0Mv7qlxtBvQEu8iH2kll04x+N2/57kjP2Hg3vu4buetCOkAkubmbrL5FC++9CyPPTnI+JlXITMN3c0090aZnxkC3+FrX/9L7hn4MDfdcBvG0hTcPEIopAkV8DSapvY2pidmmZnKs3FDL7ff9ila267nJ489zPjcaTAFCFzwElAIIOcDzWS9TRzLwr//6ixHs9vY0ZlE6DzT2QhpX5Fy82T8HAVjk5qbYm46oCnZhVYbCMRrGGEBEqlCm11lDArQBlLzBSKqlycfe52mJujukwgrIJ+3ee5wlt5u2LVnM8oep7nT5cbd/P7kGN7o6DAb+2Hnzm7syBy+nmZyAk4cPz7enDzuZgtsuv0dNgGG4eEMR19muPDC/D+NT/FfP/7Jdw5Nznmgoyiti/JoPsKEamUaQFjIYpfUojwKrM32M1Q9K7gFPL+A65GUHp8bf/npzw3cGL9h91v7STYnmJ3t5dCPn6Lg9uFEokxOz5BP5ZlPzVPI5EI1ydKQKCCbLSCxkSLK7Nw8b7ujD8syZPMBEScR1nlRFa10LcvHqFAhLdwpEIBasCFVSqK1AhEqUxoCpCUR2kYFPr3dXcRaDK+dmb7v6JFX+67ftXu4ZFMpTEheriSUpoVeUJ4s1W090GIpMazq+cvH73rPv8Ly93X5hND0dVFW57/XVPtuWs/FY+uN/Sy9vi9QVmW6UPSz9L25ZHVZy2R4iTw2RPgdupwU8ADVJ7iPsLIyVmvx/JXiHXMstSWrhtJ3ci12cfdSG8GhmprNKcqkmmp1sJJq3KXAlUBwq6UMtZAxV7tfF2rBeiFYvjj23uJvaxmHHgAequP4Aa5u4sgAS/vNVsJ623eR0q/U7q500lYl9FMb4eliLhauVwmsXuwnfCbto/qCcwjr4EonqEFYxpsJnyW1PCv715hPpfqqVE8PUtuz62oeZxpooIEGLjkaBLUGGmhgTVgDyWAJzl+1e0WjWrBlf70J1ll3g4SBqtU+rPYQvpwP1VuONyuu9vZbofy1ELVqxX5qD0bcTOVg1ynWnyhU7bpLH7oX+/7tZ3UCaUsxz/1UDh69adTTgKK6Ql19cJDyx36tK+paCIPuA6ygotTAmxcXOv5fbqxQ/iGqE7VqRdUJj0X5V3s3OsT6Ty49SOXrPm+1/OV+fr8hIHSo0ANgwLIsAo9Pb+puozlqUXA91DJ7OSi2nUV/awGYknWnVbTKK6mklQhdctEWIA2hipYOSSUGjZSK62/oYXZ2lp7OLjLZFKCRQmGkJJvJ4QcBhUKWQj5DanaOs2fPEgjJqZOZhzdvm8UQoSkiyc2FCmqBlAskAqHFQrmN0ASisGCtpkVIhFuO5WSW0nPPNxLMNELkMVIj9NK2qNFY0RiumyBmt3P//b86lM9O/Nsvf+mH/+6lF/lRZ/vMO7Zs68dSo/zdgfzr585wwH7f9B9pQc/IUejdOIxlCYSEPTdbdntnAsuexZaGfCHDjTd08OwzU3i+wvMLGBNw3XXt/OjRaSanPOyIg6chkXDwTQE0GARaQ05D1rcInCiPPv4qVsQBP0o0kCg/j9F5hJ+mMzJPamaSrdu2c8c9t9L31i185JY4melJVFQx5aaZz6dIz0+Ty6TJptL07NjKTTft4vZb340MNjA9lSWebGdqej68B0KhhARpMNJHCBdkHmSerx/8OzLTZyCiEaqAwULYoLSHp13Gjh9hfuwcJ54/yubua9h1wy20tbcxduY4Tzz+CDNTI7RGwOluRmTSWE6EkblZaGrFaW5FSQ8p9QJJSQeGZiFgdJK+SJIfPfhfiZ08SxpDX8dGZr0snoJAhHc062bp3bqRs7NpUpMz9GpJq+VANE6GDHp2lCe+8xVOHX6Ou9/+Hjq6NvDSy8/yzJGnGBo+jvFmES0OkY4ujHSRlk+yNYbWNtnJWX780N/iaZe73/4ePF8yO5VCGIkyNtLAuXMjKGUTT0YpBJqCF7B7163097fy9W/+Ha7tknU9lGgBL8qOTTchA0FrMkrfhjZ8f5pAT3Bk/EW+9rW/R8Y68K0oQcTCKAc71ozjtDIzkWdjZxw/NczbujZiRAEnGsGUVBBFqFSWz8HsrI8ICmRzcO9AB3Op07S0Rchk8uTn4ZZbNmPZgtGJ44Bk921NFDIJ+7nnRjESpucmee5wiqYmyOUZ+9a3+V+2X8Nnf/lXNm3avKmDF4+e4NFH0z8bGeUXP/2bv5ibmJ0l5Wo6miy01Gj0grPl4i4odKgKGRJrw1FIShaU1UKU+rsO24MAjEQLC8vIIjnQQ+Aj8Tl9zu3u7ea3d+5I/m5fR2vPrf3XoEweX0wjtUVTMoHvwk8GX2Jrf5K5yTTRCCSiNk3JCLZtl8cHI2hpSqKkg+8penuaaW5OhvazgYdl2QgtQ6KrDq2Vy2qUSyGEjdE6vFgWWUUaiZAyZMOJUAkOI9FKABbz89NEE63s7N/IiVPHPi3Qf2SKFqGg0UYsIeQCiwh2AhGEhDipSuP8Suqay+xJF0iDum5C12KinhbFtIxcsj8sHMV6Kv1dvobzzl+xzLCkHtcpf7S/5PzFOQpTVZ16OQ5T2/fRahO2rfVmeBGx0jvoAS6OotBKae+hOpGmRKpqIYyLLFc4aqV63PAUK1vMDRBe30rxlkOsTfnnQLF8tSxi2Uf1b4RqxKq9lNtSP5W/6we4PAS1Sm166BKVoRrZ5AhXb9xopb61nzKpsx4cJFQMfJDaFjGuF/lwgLBvDCwqxxHCch24iPnsW+G3+ylbfl4oKrX9WshNVwK5cyX013jc/ouY7qUggw0RlvlBwvZXiai2XqSp9brOg5TVFfezOims1rhwPaj0HB2s4fyBi1OMBhpooIE3DxoEtcuMRCKxrunH4/ELOj+Xy1XcH4vFKu7PZrMXlP+F4kqfgKp2f6rV/+VSb4IywSpUPKh9ord07GIFi7VexyWqv34qf/CuGiCoVL7FBI0a6+8AlW3uBlj2AXyh/f9CcaH5r8f4cSW137WgxvLvJwz+XMgH25FsNltxJeOy+1stIHEpVhHNEtodrKbos1UI0QrM1nL/qrW/Rdc/SGUVtX2EY0QlAt/+5T9c7ufXeuS/OM0gCPA8b9VjVxg/hihbd9ZDxLm/eN7ioPhVjytxfK0H1cbd9Xi/vNDx/3KjSvkfoDY78kr4BhXG6hXyv7lK/R2oltZqqGP8PUxlAv9A6T+X+/n9RsLGTX1EiCOMxDI+bmqcnddYn+xJxvBmZ3ASUaSQCG2QS2zcdFFFrUhLECIkhyiFUBKFREoVqooVVWaMMSAlUkqMLimbiZCkJjRoQTIeJxmP09fbi9Aeba02mvD5YgRImURJGSoR4ZCd18zN5BibmuWG7c7HTr38ZO/0TO7Lp87w8L7f/VTB3LiLrLBwLBvhB8jAYLxQDUlYAc8e/QlGumVyShGl1qRFSRkuJBGUCARaazRpYA5pxPn2cEaCcRgdfx1lfObVOJPTM5hChnfesyX3/LOn7/3HL099+wMfmLnvuus28oX/WQ68/PKp3dMTqK4u6O5uIxJN8NxzZ9myBXa+pZtcdgKtAxJOK0I0MVkwnDwJXV3zurU5LtE+vX3ttLRMc+J1uPaGTpQ1jJECbQSWtBBaYIyg4EvSXsBsYZ6o3YzWFlIkMUrjkicRs/ALPqMZuO8jv8c977wXJ5ZEOK1kMy65TIrACLS0yefz2LbCUj7Doyf50Q8e5vVXXmTszBjbN99J1GknkYjRlojS0tKC63u4rk8+CMjrPJG44tzICA/93Z9DTEPMIeIYjC1wEWjt4gib5kiUeNJCuBqTGmVqeoTHjj6BDAxeIYfjeXR7LsqUiS9Zr4BPgdZ79xAkFVbeRQYCX2kEEsuJo8Zm2TExTfvoMWYPP891zW0kZZymSA+6L8KEcTEiJFBGYjHSOg/dURgfpn3aomnexxc+zRa4QuMjmD83xsNPP4HTlMCTEl+Fp/itLbiWJm98ggD0vEYICy0EVnMrfpDm8R99i1Rqhnvv+UVisQhzkxm6u7pwbJueDd3Mz8+Ty+U4deZlUrlx0s+eIzV2ilxqnrZtW/jQu95Pk+omPeuSaO3GwSIuDBFEaPWq0xS23MUDt/4af/3//hmnz51AORGcSIKACLPzBtvuIF+wiFgJzo0fIwjigCaQEEhAaPp6HV475xJ1unj16DGamiASVQjhEHg+x1/T+swQ8oYdPh3dCZLxKFgFpCwgOm22pOH0Odja382739PDyaERRkcykc/ss//k2h397Vu29HNo8Al+/kTq+wR86Bd+8W7/teNjRJsdhMqRGjnGayeOIgy4VrGvEhKAHB+khp07bwLjEBLQdGh7iQ7HG2PR3txLPJlESxdhaQo6IJZoZna2gAoCrutoYurc6zz6yLM3tbfzubffyOeu2d4e33n9FmJOBEtb6CDJ+Ogkp196mZERj44WaG5uJhax2X5rO1EHIpFIaI2qDUHRDlhgI4ghsfF9g7AkhgI60MRjzdgiisGiROoVokgEMxBgUMpgAoGQFggHJ2aRz2fPJ5QJAUIhhCJA4okAKRUIifY0uewsPa02HUk+2dvb8UfpnEVXSyfpXIqXh0+c98wojeUh5y0MQXtuUHowLCNslcfOxeeH4/lKTLuVSGFLBtYlCnThfxbYxyzYSJ+f8ELZFgsorlS+885ZUq6Lm7+yHFiViBYtnrJ6nQi9pOy1fhetNmF73rvXJYo/rfa+u5UqVp/Vvi8Wpb8S9hN+969Wb/uXlWtr8fgHiv8u378cJRW0xfXdSvg+vVJ8Y44LVwvfX8yzmqrWQA1pVTpmjqX1NkRY9tUW+a2Y1oW2rxrv/2q4UuIItRIRByvsa10pnXXuv/2s/L1WUigcWEP+BygTQaFMFlupn60HgWofK6sQ7in+vo9FffoC6reV1celAxSJsJc5/l+J4DZ4KQqwSlxioIZTD1E/QXJfncevF2YJx/HD1KcoWCv6K+yra0ysI75TwiBlq+v1IKOthErXVMvYe6USNRtooIEGrlg0CGoNNNDAmnC1K1DVgWovmAfWmrCUsp46OEhlglrjRbgOXO3tt4by76O8grdezFH/yp916yd14iCVLecGgIPrcP8OsDpBrSS/vxreVOppJWhdbUJpRcwStu3DVB4Pl2Mr8BzwRa5eK5sGLhLegApqEPaNAdY+7h+hxkDrovwHqhx6qewNDrD6eLCVZZMwl/v5fdVDUJxU9wkn6X1OnTret7U9eltbPEo8YsgKEyrlUCRRmuJpQmBkSFLAhGpAGImSFlKGYQklLYwJFpgAxUOLhAmBkhbaBAgJQgeYZYo1QhqQPqrICDAQEtOEDPPXmmjcxo5EaO1uRwdWTybt7fVds/fll18f/ckPHvrWq/PewyNzfPdz//KTvms8YtEEM5NpotE4GS+FLwsEKr9ATlugIZT+LhHUiqSL8nFhmaTIokyoNLQUEnQUIWdDspTwAYUUCqUc7rnnOl/K+fd+/aGRO7dfc+azO7bz4Y72xIZA50k0dTIymuW1Y2e5ZrvDNTu3k85PgXDQRnJuzOe1V17l8GH+xPV4PJfnn7RQSBkwMXmOWALmsjA3q5FWUSnOCGzLRpoAjCTQCj8QC21AGh+ExGBjOXEmZ+bZsuUm3vNLH+WmG28jNZ9ianQK3zuHMRptDJawyefSAHT2NPHy8Vf42ePfZ2zkBARppDzOM08fJRnvpL29jWRTE11dXTQlm2jrbKcl2cS1vb38ePBH/PMPHqa/M4nlpxF5D+az2EqgpcC4Gp12EZkCdt4nLiwSVoSYUESQ2EoSdSJElU08lsApEgYztsUZxyKbGSPW2cKZ+UliWAgjCZRGAM0mIHHyNPdFmrjz2l4K2of2Hl6cCfjpq2fRG64jF7fwi9aRQgiMbYh0tBDv62HHaZedTgxpK7wgwDfeAtkxkJrhc2fwFLhSkkWTEgG+bSGTUWQkihIOvrAIpMaTGrutjZlsltd/9kPSQyf4yC99hmv7e5kcHyPreQyPjHDu3DlGhofJBWnm9DSYLE4+iwk0p4aHSc0Z3n/3x3DsZs6dGkGhiAWCmLSJx2KoWBKRaEPGNf/b/v/OwW99he9/72FyGQPCJ5FoJi4S5DKz2FGJQRJoHVrsIhYROTURByYm55mZ82luCn+TaLQfIDTilVf45MTMyDvuuocvbtqWoKunAyzD3GyKm2/fzlNPHueb3z7Opo0JNm+8lrYO3ar9PC8ePTby8LeOffPsaf7mXe/a8oTnddLS3kaCBGl3Htebx4mExD+pwZPhZgzYGlSJ/2rKqmPShETbkJymEdohGe2gkHOxYgI3lw/7isqgjObgP/6g+Y5t4oMdcT55x674x7Zt38SG3hZ8cgSFLJNzswydGCaX83F9TXNzgttv30IiGicWi6GDPDlvjkD75LNZpFIoBFJKLEsVCWrFTQRIW5HJuFiWg+M4CKEwRiKMhZQKKS0EVqg0uey9QWCDUSgp8YPy/SkR24QICGTx3mlJIHU4piuJ9nyijs2GnshtDz98qO++D35wOO/55AreeeRvaYoabSb8T8nKWZiwnZxH9jIrk9MW/r+IkBaOs5W/J847f3FW56l1rnR++XexrHyLicgL6ZTKVyzXxc5fBOUQvl70nAnTq1tBrdb4UX+9Ca8j+qn8LfcFwu/EA2tM/wFW/6ZvoazqMrTC/oEVfttDSMKao/r7+T6WTo6XVNiXn3eKsjrTharFlcgNK5FsFuNCyQEthNd3YNFvgxWOX+0eVEOlNl0pvxIGKuy7VN811dDPKgSzZRiosK+k9nep0Erl+ruXsmVhvZilfC2lf//DCsddyCKu1VAtrnQvF8eGs5JKXIkIO8D6OQbUkm5/hX1XSt9ZDfWST1uprCg5tPairBnrde/7K+y7VPd1va5tJexl9euq5Z1pPcaZBhpooIE3NBoEtQYaaKBuLJ4cXcsk7+LJwatgkrDaS+hgnekNULbjHKyj/oaorBLSIKjViKu9/dZY/sMUyVhUXxG7GCWSQr0fgZXa3/IVs9XQWkyvv3hePecepHKA9WYhxMF1uH8HCIO7q9V1pQ/V/RerEFcDLhI56EHCdnGQ+oIAf0IYdFi+Or2BNwkudPy/3KhS/tK4P0h9/eIINQa1l+XfXyXNS9XHBqvsX5iEudzP7zcONIut2c6czd+9q7+HaDSK0VmElAukMiHLMmNSSYRUaCEwRbKYsm2UUCjLCslqysX1fMCEhJFiOlLaaBNghEHghzP1SoFZqj4jjA2ibIkXEghCyzlTJDekcvMoaaGUhe1AR2eMXC7PXQM3945MTP7mpumZ3zw9MXXm8R999aGcy/838K53/Tje5OD5GZo64hRe9wgIFmgFJcIFlMloYfMqyeYsrT2zAnGhDBdLTSK0RBmwjIVSUaKW5tHBV5O2w4bmFl4+eZwvvPQc/6sOMvbmLWw0eqxTSCYth7tOWO6npjKv7PIC09bZaXknjvunxkd41BF8+bobdgz+9CfHmjI5hNYFbMuQzedobYNjR0DL0VDtSC5WapRIITBSEbLXdGjXKMI2kMuAcW3e9/5f5R13vht8i7NnxklEY2TTPoVcfkHBzjMFEnaE1vYor519gW/+4G/xvDnibRG8bBwpLawIuMEop6dPw0QAL+agKUlbZwc9kSZ6sDn9zGGu8fIkRjNsUIY23ycZeNg5l97mFhKWRbOdIG61EIlBxEiikQgKERLHpCBiO1hCItwA4QcoA0MRi69FJC1dm3FtB3Ia3/hFKiY0uT6dM/P0njzFL8Q2cXPgUJA2nivoUxHODZ9ibHSEINaJ54cEtYLvI6QhFovTl2zmRjHFu5uTNEdiuKksMaGwtMbyDdr3cZtieEaTlwZPQUEa0oFLKp0nPZ0lH2jywibjQMqBkfFp0nHJaHae2blpfpBPE+vqZmJiAt/zmJ6ZBsBxHIKIBU7oMyiiFlEkiUic408/weM6wcA7P8TGzm5yKY/c7DwT6XmSzRKZDxA5BxUx5POwd+/9bL/uRh46+A+MjJ3BUMDTPoYsZoHgJAhVyOywX8iQ+GjZcPbsOcbHYdttyYWWr4TEGIRM8L2dezZ+7dCT5x62Dmd+dfOWzLs6usTW2VljK3F8JpvhhaEzfOXcmczPfuod6bQVk+MTnMsV8KJR8okEkeeeO70jlT09ctc7M+l0TmLFE9gRh8B1MYT2qwFgjEIbTVAyIhXgW3mkdpFFD1CBKtp+hspk6WyepqYoyDzf/vagbVu8vSnGLbbknvvuaH7XjX2JthYH+rZuRdkRpjMpxqbTnB0bp5DN0pKEWJPF9r5N9Pb2ks9k8X2PXCFPuHYjihI2QgqUEUglUcpClRa2GQuhQgvOwIATSYRjK6o4JoXjkZTWoue1XFBdXSD8lupdOQTGXT5MhffQqFC5skSEEhJLKQquR8Rx6N3QS9foyN2xRPwr6ZkUTjTCYkvLZSNfOW0TEtdWpJbV8GhesLysfmj188+XR6t+fvFfvcbXiAvJXxtTrl9BWY2tnGI9+Chle7DVMEBlEsYAl4boUiIEVLIxK+FvKCsp1fouejPhN3mlhW4QfusfZmXlskrlqlbmP6U8KX4zYZ2XSFqlWMpg8ZiLreR1kNpsEge4sHu9v5hX6Z70Vzn+Zuq/1gslB/Sv8vtaFJbW0AAugwAAIABJREFUilNUjt+VFj/uq3DMAJX7bX+9hVojSspf+6kek7yfcj8fuoA8B1mZoHaxMUBt7a2k/L9vDXnspTJptoQ9LFVrXAv6K+yrpR+uFg8+UuP5lxP1xiyqPYeG1l6UNWO96ni1tvclLl2s53CFclxs3E/Yhw6ssG9fjWkMcHksqhtooIEGrko0CGqXH4PrkOZqMtmVcIiGV3YDdeBqV6CqA/0V9tVDvGkl7O97YCEwXPOkcBGVpI37a0wDykGvelBJsruEtdzQd3EZXt6v9vZbY/kPE97rWoK5c4Rt4kHW9qHZX2HfYB3plIgEi8v6JWr/GJylclCvH9bt/u2n+urj5XhTqqddpLofpGxtXM+q7nsJ63wvjcDBmxJvUAW1Eg5TVpe4f7WDipgjHLfqeh9YlH+liYbBetK8QFR7D1uiEnC5n99vRLS1sUspC9d1KWTncdpay+S0IoSSsOhvbUxImtAGaYeqL6b42wIRY9FrpZECjIUxBmlF0doDHWCWqZAFQgNO+YeQjUFp4l5haGvpxBDaTPu+F9royYBsZpzergT929sQ9nWbj58a+/zYZPrzp1576qdPPJ3+ww9+5G3fkZEExgQEi4u3yE6t1LR0KdslkAvXWayV8p6FS/URIoMSILFQxue5Z1/4SF8v999+O/du6GnqcByHfFYycc5/amQ09Z101v/zTVt6D7e29JBzc4c7eiL/7Ts/eKFpLkNvMuFn7rl353Brm43xOlCOYj57rCvvEpICcUkkIjhOgYIHI8PQ07OovAaE0UWVnuVKRxYYh/4t2/jA+z7Jpg03kkoVGB8ZwbIUs9PTJOIJTFAmESrjMzM1xEuvnuSff/RVaJNg+2QDD2amoLOLwtxU2FakAClDC8/CDDMnRpnJubyS9tnW1EIibrG5awOtXoE2I2iXiiYhiRuB7WnwAlw/JOTkPB9/bg4tNDJio4HC3AyWgYiyiUiB0nAqEvB8OoXavoeR6UlUIoLyApRQIAwRGTAzMcGOzhaGEWQnp8gGHvnMFE7XZvSGJl4/c4qgtahkFGjI50AJ3GSBbODxzMgJOto30ilayKZnSAiFE0AEiRLhGKWVwQhJAHhCo6M28eYoMRVlbKYAyiKwIXCgCYvp9BQBASh45bVn4akMdHWBY5NsbSMIfHJumiAvQERAagr5FAXfhUgckYjxzDODjI1OcO87PkjEaSEWS9LW3Y4vLHK+oTCXwfVdmlsjTM+eZPO2nXzuN3+Pb377qxx57ikKBUN7MoYxueUNf8kHorRgbAzm5qClpQVt8iEZ1ciQ9hqny0R70luvtQaR7qAbZHl0cG6jZRG3JKM33NCRuuWWJJOT00TtKEePTmy4/kb+9ZYtzR9sabHeqqRHNptibIKp14+/emh4hAO3vG3zN9taNjI6nEKbkLgaCIEvymXzi90xkBojNGiJNBJpTJFQJdFoIlaOr3z1G8mtW/mdW98S/3x3R2xTWzxCV1sXCccmYjzijk0sHuXwiy8xdHqCZGuSTT2baGmNkUwaAj+D0Yb51DSWkFiWxHaskHxGBCPsouKZxAQaREhGA9AypM0FokgEtEIlrpATW1QnUzbSUkgR1qmQi62Wi6PPIrK7khJ/GbcpJAafr+olhEQqhTEax3ZwXXdXLpf7SjQep+DmMNqgV2aohW0h0OWh0yy1Sa4Fi5O+LOcv+3+9lLALzV9os1B/wpSVOQHM+aGYWlS7vlDcDq2wr5YJ4QdYvzhyadFaK/UreN1f3A4RvieuFN8opX0z9RGbWgi/+fezdDFdNWJRJeylvDhvlvLit8E1plfCwLK/S9fcX9zqvfZKGKJym9laPOZg8d9qC2z3U1ustbRorZbjKqGf1e9fvbHTC8FQhXKUUGrfKy0IquWe7mP9SGqlPgX1k0o+WtyOELb9WuOSs1S2373cuJ/y4uFq1zRQ/LfeuiupNZYIYUM1nLO471Rqc7Xch9XG6EvZd1ZCLWXfR+2Lhh+gOgFysMa0Lib61yHNSmP0gXXIbzVcajGGUkz/QPHffsI2su8Sl6OBBhpo4E2BBkHt8uNSscAbaKCBtaG/wr56lZ2Wf7SVVjrV+sI9VGFfPcGwVhpjz5sFs5QJCHsJ29ri9lZajTvIha2AqtT+au0n/ays/HM/Ydkqre5ejKEK5emvMY214AC1rQ5djP3rUZA3EUqKUQeovuJ9MVoIA3h/Su3tqoEGrhbMEgbQHiAc9wdYOvYNUvtkzlpxqScIDrH6e00tBPsG6oQwZWKHEGxOJpNorYlGowRFhbCF/VIilFxQGgsn6Et+eiCFwAtCy1AjQqU1Ywxos1QcRlpYUhJoDxEodKAxwitmUqIJlNTdQFAqR8jMkEJgTKjiBBI7YmE5Bq19sEDZNkEwT25+CuXYXLOhiU3dLWzuyd3dmhj+9otPPfnnt7xj1++0xCLM5bPMz0M0CnasSDwTgNahqo5gwX60RECQxesVZrnCkCyrqQmN9gtEHcUj333B7unin971bj523bUbSdh95NMwPDqOo2DPzX23vy0Rvf3EmSP/4esHR7/y/JHRX/3tf7UpmE4F3PH2HSktSGEcPK+JaLKdIBcjnR1n0xbalAWWsglyYDsR8rkC27bC+DQs4pOhiqpLsrgJIXBsh3w6oKmpj53bb+GD932CTKbAiRNnyWVzdHd14Ll5jIZMbob21jbm5+fp6Ggnnxnny3/356RGjkF7K607dzM7dgqsAG7oxJI2fqoZTJFkqHXI+iuSdYQxNBlJRhs8qRnXHr4nML6HMB4KgSUtCATaNwhPo0zYPISIhG1DliwGLZQQJJSDY0niToRDLx6m485b8VSAsNWCNaFjSQLXZTKVASF5vCPGy0EeLfPEI1F8IcmraebabIJYB6Tny5VoTFip8wHHXY/Z3Zt5zfWRZgbRB9IERaNDHVpKlpiNMlT28jVoGYBjMGTxusHXZVvQeDJJ0B3HF5qCgZhUFIpkKoD0QiuTIBUoCUEW4h4oB2wbWytcfM4eOcQ/Hj/Nv/qNz9Pb3cdUNofGCm1rtY0yimwmQOU1R188DTLL3g/fzw07buXpnz7O0GvP09VmF/u1WbB7DLeQnDk1GaqX3Xqrw/DIMC0trYBBSEkmB3aM9nTOnEy2bCU9N4uUPm95S885IVxAI6VkYmqCf/hqRt1yc+rLv/VbOz8VsWymR1PMz87R0dHEjm0baGpzOjL5zMd//uzJjz/z3JmHpn5+5pffNfB2LzCv40vwpMFTxcYegG9CcUAn2YyXzeMGLi2JCJbrk5tP0ZRI8MJLr8mXX3j+i7fvtn//uus7erdubiVueeDnyafOooMkqnULUymP5x75Kbrgs2fXtTTFYyTjUdwghxGgIzZCFEmMpqR4JtA6JFBr46FLCm5SLdzB0niihcAogRAqHEtKNo8iHGelZSOFhZECVSTTGhmS7hLJBBgHUwwF+9qE9psrYDFBTcCKymiWZW/yPA+UWCAml+xEdeneL5IaC01Li5e+Yq7VURovz3NJXhHLSXa6/vxXsR2tLf/zsZ7XL80SW9B6VEfWGhsqEUquVNzL+sW9tha3i3H9FzOty4XDVF8c01LDMSXU07bmqEwemKN6rGu1mOwpLq1F4RC1t9m1Wq+uZ7+4GNjD2q5tjit38edWQjLweqPeupujejys2nf9wCq/n+LSEplWQi0xia1Ut5gdIIzd1tJvLgdRslK8Y61x/tXGxENcGQt959Z4Xi1k8hIJvZWGbWcDDTTQwLqiQVBroIEGGlg7an3R38fqHzJ7ivsP1JDOIJdGrryBNx5KK3EvV961YD+rf/x9gZBkN1RDOoNcvoDbfmpXUXtTqqetA2YpW0fUOz5+gTDYtJfGvWjgjYfSuH9gHdKuRqwfWoc814r+y12ANxKkWUpSKJKvkot+QRcJNwAIjZFF1T2hWLCfQ4eqaELgaR+hJUKYBfvLxQhV7yRCgEEglUIIg1Yare2FfEv5Lf5bmuJvRi74sS3YvOKD0EhLoaTAkgJ0gB/4GL+A6xqkFaPZgnff/hb6Wk789uBPXtgkOviwrWFzZ4xMOofll4kCrgFXLuJULb8WltafCAuypH6DfAEjA3p7+dH739d+T/9mgTJZnnrsKXJpyOQhX2BmdOTU3Kat9Lz/ozfEPtvJp3786HSrpvBeRSwkeBkLJSMIFUN7GtsRtLa0cOgQd33wvVE8F3zPIh5rYnp6nvYORUe3zamT+QXC1BLJpSLmZue5Yc87eNttv8C2LTcxNz2DEDZtbTHa2iNoP4e0PBw0li3JuzPYjkFaLs88/WOaIgWSG1rBRFHHTtPX10Uh4pGPFHAtG6+zhaCogqe1DtX2tEHpsEzKD9BoCsKAMgQ2IAVaCYSwkMLBaEEQ+JiiG6zRBiGL9obFGyANWAhS0sIRisBz8RIBk50JZETjS4EqkneEENjKIu9r6Osh6GxjOm6jCZh1fTAST0oCBE1aLiHkGAKMMTjKQmuNawxTpVYqyq1VSgFGLpB7pAgJS1prkAJhhaG7IPAxgR+S8RAgJAqJRBAxAguIIkIiU6ldlfqRDwRg4dEU66XDMVhTc8ycHmViNkO8t5Oo5fDDb/8Dd3/ww3RdsxNfG6SncKQA7RO1JMoGoxy0hIKbY/euXWzp6uPJn7Xx8gs/XtRaimpki67X86G/P4qbKeALQxAESOMjlUN3D8w9zl3RmPVM4Gvi8Vby6SxIt6iGqDGBYnomIz7+Cb771re2/2IkZjj0yEu5Y0cZ7+ukeaJrri14HjZvgevfsoGbb25m+w7rYw9/ffpH6dTovUaAj41nLIKgOFIZH1W0Dp6YyRC1HaKOgxCG+fQkzY7ghefPfXpDF/tvun7bNS3tNm1tAuPN4hayRJSkkEmzfee1nBv3ePTHT9LWHOWOd9xCXBmkdvHdNNr4BEohhQWUiWeGIm1KWAhhI4UMFeVEqI6GUQt1WOqRYTORGCmKY0qJ6CaxLGuh94qSEltJgU1rMBodmpqitV4YE6UpjUnLtcEqaoUlS+ci5RLrTmnCsXAxEUss+/8Kz5NVIVlqjSzMUvpZ1fNNhfxXVDOTS8hpFfMXFWpozfmvcP7y/EvPt1KCSzHIlU1CaeDqwlCV/QeBP7kE5VgJLcBDFfbXQhjZu8rv++ouzYVhkNpJfA0sRQtrJ+29WVFShFwNR2pIY7W+s7/u0lx81EoWK6ncHaBMvmqlHCusdRHySqqGlwKVCGprJcxdKfd1tWtb63UNUdv9XKsiagMNNNBAA3WgQVBroIEGGqiMi/GiP1Bl/14uzgRyP1fWpHADbw5UU6e5mP3kQiXi11tJ5wC1q6hdbrn7Nxr2E7a1A9S3ym1P8bwHuPwrPBto4GrBlaZKVkklpP8SluNNAYVACYFBIMIZ8TyEk+uLTDxB6NDGU4gF9bTScVAkDhlD4Bs0HlKo4oR/OIsfktrCfBasy0oZSBAopKwczlhQFzIaU7R3lVJgTIAQGj8oAAWUCK0mjZZY0kbrAK0NxjXEhSCaz3DH9i20OJEPPXToxF+1d9i/WZjNsaEpQTabWyCoWYDvhDZ81ZyEQ4U3uUAu0SJU0GqKJjny1Ev//o53cM/Ne9qZmxjjuadSpFNw661tGJkn2dTdNjYq2v7qr4cCX73MBz9yHduvKdw3+OjEHXfd1fpzXST04Xsok0cpjdZppqfPsWkTv7NxUzuB9jBGUCjEmJiA9o2CptYop4byoU2fNkip0NJgZFEdSSgikRjp9ByP/fw7/OCfv0ZrshXbjpNINOHYUTpaO5DSwlYWSkpampqJJ+P801f/kjNHn2eTmGeLp9mQyiCzM/gnJpjtjDK8OclUl8O8yFBQhfAmB7rsm4oGYRDKhBpMIiQ5moBQkssDIXws6YE2BL5PoBep6JUsZqUokhZBGoGtJTaS9MQEkMdvsopMEAvjBQhAKYsgm4XpSejtw/MFfsrFchzyeQ8IECYkoklCUp1ZZOlqjMaz7AUy0AIR5f9n782jLDvu+75P1V3e3v1679l7VoCDZQYLARCWiCZFUiJFm5Aly8wfiVqRzonlOBEcnxPbSnI0spNzkpPIgiwlThwnGiZHx0dWHAFSKEuUSfaQBBeABGYAEiCAAaZnBrP1+rr7rffeqsofdV+/3t7rvWcG877nvH797lJVt7Zb9atvfX+Lv+vpE6Iu+WZJlSo+pqxalo4U6HCh7tQV+czC8zkoIVeqKwmBpyTRXMD9HXm6rs4Qvf4mDyiHsFBk0khmMwr3eJYfz7zL//PCv+Kzf/s/QmR7qIU+qiKJqvOY6CaCEpGMMEJz4+YNbDMyeDrCoGLVvaXRa0Fcp2Cgf4D5qVkmbxWIogjhKBKeZO/eLvbvmfm1+ZnL/zybGiDp5QiJwEQIYUlqQqWZneKJp34i8+lHH7+fL/3Lb3PzGv7f+Ln0oQP7MsioSlSD116Z541Xb3DqY1mS6YjTp/n4X37l0n+jPf6pMp2ocBBlOuK8mUOJa0CZSuSRSGQJoyLjc+Pcem/ywcE8z3/yE30/dd+Bg3QlOomqFYqlW5QjRUdXN46TZHDAR+hOLnzvJfrTHZx+6CS5TIJSaRpEiONqhOPhOKlYvcyqjWml0QIcJEIkEaRAeEgpWvchdeJfXP5iEdNLGZDSQSzoSNp+2AhJEEQx2S8uF2Osq2S5nF4lF31iEpSok+aWoFbv3YUBVMO9s7HMO1tu8cPU+/L6NYsJV7FG3CrpaPLsjcewV25CkkwsJqCt6/6lxL0l6Y/7lY04/txo/Maoheu0II6vLqmmll/+Au3NjbuN32V3VJJuB8bWcb6VovHtxOg6rlmNjHE7lIJeYP0bHttYP9ZDtNoI7lR3otuN0XVcs1rbucCdYVsrYNOyHuLiIew7cyvvzd1UW1yMVpsHN1NX86yuYPkiu98nNiu7zbbBUe7M91QbbbTRxj2JNkGtjZ3AaexgZow2WWajGIo/Be6dCc92YYidybvt2IE1tMb57VroHaLd5trYfazXRe1aWIvUtR3tZDd2VJ5hbaPiOdp9/E7gBRo7HzdS1vWdo8Ps/i7pncCHdRw2HH+f5/bsTG3jzkW7Puwi6qovSlh3mkZwQwuNFlbHCSwpRwqB4zhE2uCAJUEYYV3NGav8ozGxS1CNEQZpNMKyHOz38gX7eDHfLE7MagQGYjekQsbuNq2sj7FMCUseEhohDQJpCSMiQkofLWpIFSGFQaiQsFxlujDNwf0HOLK/j6cfDX/lL75x9euZPH+o0imU8RbSpVGWHbJIQq1OJrAu/TSIAEG05BxoJAEOhh+//qP/5eh+fu3YoSTj197j5hXDXAGe/liafJePl0owNT3L1OQ8nxjG6d/n4jsJSvOlEoZrgsi6i9QuGI9apcjAYA8TUzd49QeX/s5nP+/en835iEBSCSSF2RLGQCoNc8UCQoLSGq0jtJQgDYYQjzKeKYNW3Lx1A6Wq6FqFG0rF5BUPtIvUgjQOHV6KDukgKyFqdp7K+DgPJFwe39PLHlXj/mSSA715xotzXCxW+e6Pb1G9+AG9D5xgKuVT8iRFCZET+7LUWLevUhNZWTRQIiZ0OVZlTMSqQhqc2G2jEhKFsTJ3UtuP0VgBNoHSEeBAsQDpFOiIuNJglMF1JSqsUZyagWrA3v4+akoTFSsEtQDfT1olPgPGRLYdxKQ6LSwBSBuraqW0wsTtwUKiZEw0ETZ9lvTpWHInGoXGwSERO4lVQhPFxExlDAaBMsY+uxAgDUJa1TUjLAHGU5BSknwN8jNlsm9c5mC1wiN+H0929ZHudbgaVvhxcYb3r93ClArcNNf5zvP/A51H7mPOSEqhpBJVqTKDlhVwNKDifE2ScHLIWkBnQiOlRui4ZeoGIU8pyKTAI+TA/i4uvlNAB5JyBEnXkEm7PPVo5v6vjY7/J0ePiv+tqgIQDlpoW8WMxDGSSoVrE+OlUqVYzdx//36OHq44k9NTPPhgnrBSwMvm+NQnHuPPvvwDasUq2e4UB/enOH268k9efZM9ysz8XaP6CeN26+HiSQcPSV8yR9b3mS1MM3V1/LmnHun4nf2DKYYO9aJLBWqlCKkMnuOScTtAJ6iFLnv3HeOV7/4AFVb46GMPkcslCIIywgHHT5BM+Xh+muJ8hDCupfcaiTaWMKYRYBySySzgYuKezdaNBuHJaLOUoFXnJi30I/V6ECsG1slMGNt+qMcXu0KWdRZZg4gmFxHYVoMWEElLrJNGXsdYt8xCgFF6QQlTxOVfP6frdXThYVZ3nbkstqU/RXPy16pJXh5mi+dacWqBbFZP5/K49aKbbJ/SKn1rYfWkNRTSpIFI1bXvll2zOA0NnOfOJQxtFTv5XJfj782opzyH3YR2hg+XCtZ6Xak9h138v9Ncoq1ldxlh9TSv5fpwJ1DAKu1/mOpPHbezP9pu21uB3X2ec1gbz263rbXyrZm62O1oO83wPLtH+rxdBLXhJscvszk7ycgqx9bjDna7Mdzi3Ogmw2yT99too4027iC0CWpttEQqlVrvpSOs4sYwnU6DZdi/wJ2xe2JXsc78G8EO6lfsTkilUudo4Z6pXC5vOm13A9aRfyM0yTvgQiqVOovNu1UH5OvMv8u0pX3baKMV2sSApVhPftwuw8W9gLoa2tc3eN8su78bsCk2MP4CS0YbiT+rEfNexL4LF+rdBsPfdqwz/iFsWa4wfKbT6Vns8zxPm+x5O9Du9+9RSMDBxUFghAGhqNZ4Y640S/bIYUpzFcrVChnXQ0oHx5GEyhCqCIETk9C8OrEh9kFXd89pl91NrAizoLRj5JKF+xXKUEudvDX+tb7q7L8LHtAESmukqaupeQgcwMMu7ocY44GpgggxgPEDnJzHtbnrJDO9nDg2xMSs+b++/M0P/uKv/7WPT43PhqQz3SRdhzAM+f3//f8mkosc+MWEAWk97fGZzx0AUY5daEoSbpooKiGkojgV/eePP5j9tc5UyL6OAcKoxIF+zezENJ15STarmS1VkdJnYkKRz0NPfpBvfPV13rtIrSPHbE9PEkwOV/SRTnYSRgFzpWt885vvPfLU0/yLE/ftw0tIZgqz7N13kG+N/ojePdA3kGK2OI8jYzeSRNZdphQIXWawI0t3soQslVBCoaUDiSxoDSoC1yPtpxjAQU5MY94dI1sMeNjr4L5UJyd6DtEhDKlAkwSSUYQzNc6A63JUujyqU7xdhpe/9RZX+7JMHOljdrCLq2EE0iMZWDWnqhvZuqINGIUTWQKUcW1pV+drdOd66HBzBJGmrDWBMNSMRikFRiG0IRNqfKNJJZNce+cdSCVxevugJiyhjQAjBLVagOMnYOomqYP7CeZLgCQjXasAWAssAceAcSUkXJQJkcq6Bo2EwmCoqVpMYrPuSpNaIIwhkJakZjkoDlKZuM4YwMHRXuzO0yC0oqojlIiIXGMJmHVSqIh/K22ZYBLwPExN0+nkyI5XyP9ojM/WFA8rh4FUjo6aQ/bWDNJAxoGjMol2M8wkc1wtz3JpqshbN85xKyOZySeYSCWRe4eY9VLMiyqoCpakpojCIkkXjFJ05zvwRAkXS06SRhIKm6yUD0pP0T94ANeF188XGf74MYQsUCkXeezkAWbG3/lfX//RrZd/+mePv1bUSQrlGk7WxcEhWdZ0dDD31uvUOrJvZe4/cYyZmYBLY1AoFBgYAIIK1ahAMg2FiQjPcUh7HocGKuSz/NrLr6m3DnyE30ulOqhWA5JOBjXvkhCajxwewtQKvPLD63/w15/sHzn14D6qqkC5eguNwPUkXiKJECkcJHOzVYYOH+WtNy/x43cuc/qxA7jJGSrBLEpBMp0B4RAFkjA0CJIgY1KrEGRSfkP9ztLLYoKrPWL7kUXqaEvYY3LhX1tnxMLVQrHg1nZpEJYkK7GuaLXR1gUuAmMcSyI24ApBFMWEYSGQwvqXnC0U6ejqQAmXmzPXKMzU3ujI9FArl1BRYJUE68qFxmBiDpeOlQONFgvnlvbfMamtfrgJ0Wtl/78UQsvlB7Z2/1rxLwtfLM5nYDmB2jQhVC/cv4hsBvVytfcoQLrOarfFN6+krmHnBue58whDW8E5GhuSdoLE8xx2g88om8u3MWy+j/HhWQQ/D1CpVFpelEql6vPwO00BbHSN82dWOfZb3L455nNYMtKHyV3lZWy7PcPtaRejOxDmbhIyR7C2kY3auLaK0TXOr0ZY+tI67ttNnMWmc6fb02W20GdswT6XpzlRcrP2v9XK9XlabH6N13+bYpPrl83cjMLm69h52ut8bbTRRht3DNoEtTa2imHsYK/Vi/0L8ecMdlA9urNJumtwGjtYbJV3z8SfM7TzbjFOs7ZCzingd7AD6+fYPCFkjK0PXEdpvbNquwwfo9sUThttbATbVX/X2oG4HfGc24Yw1sJ6dpXV3Um2SR7bj824TJ7FjmfuRqJT/XlbGUbr47Bz2Lp3NzznGVobrzuxi1K/hDWCPke7Pe0m7rQ6NHS7E3AvQeAg8XGMJcckE3y1UjVcn5jixuVLHL3/KEI4GCOIIoUQHkopHEehjQCtwHFiN4YgdUwiEw1SRj2mNdNSJwMYGRMFYhUgsC4gV7lHxvEYI3GkXFCEs8QNHxE5hNIqdhkXXJlAuJpKtcx8uUBPvotD+zplJvnBH6qw9jODg/soVgxhpBBeBh27uSPWk6unUSLAicC4DW+TBrTWCDSFmSi7r5ffvv9YDz/8wWWK+2fpzGdwspLZmWneeqPIfR9xKZV8/GQH+/dOcXMc3nn7A7IZOPUw3e9d5DeSbvofT09W6MyFjI9fRjoR/+bffuepxx7na08+dZB0SjMxeRPfTfHGj97i0hg8/kQKpcF1XYSIiDREcbkoFI6AbCKkKwWOqauFAUbja01vKk2yGmLev0L3bIUD0me/38H+Djjld7I3MuwphbhhhdCJUFIvEFREIOiQkr1ScshNc6wrx6tRlZffHOMxXzmDAAAgAElEQVTSletkDx9i1gNtPOZ0BAkNrlVIc7RsuMysEzmqJaZvXqGiBHuSHQw4HmGtRKk2Ty2solC4CHKBxggH1dcJcwGJvj0kU1nK80WEMZi6wp4K0VcmyU/UOBbNUatN1GsSRosFF54ASsJ8UMXJZiHhU/AFFd+AJzFaojVgIpSGINIkQ+gIIRnZ+ifROFGENBJpJJFwqTouVd+l5EHVBKT29YHjImNlsrpKILHmltQaoQRSRXQEmoMmSfDGW/RNVnnG6+RnpGEoVHihwMSubC00rnRICE2gNcd1knEJnz6yl7dqU1woj3M1qPH+xNs4nR2kezzKWUnZNSgT2bwXGhlV6EgK0kk/DrYh8aU1OALSvmBy4gqPnILXX4aJmxH9e13SSYkQ8/zkxw5gxNWX/vwvvvXJx5/5yHcH9x9nphwQ1ULcpCTXwW889fShbsed4YdvvsHEOJw44pHy91CYvkx3Z5Yf//g9DHDg4B5KxRIEDtPjcOJkgkqx9tuvv/nmHwwdM8WEn8RTDimhcbWmdOsK3/vGt//1z/3M8S8O9LtQm8OhhislynEX1Oqs62CXZCpHtRrx/Vde4+jxvXT3ptEiQCvw/BTKGOtC2PiAj8AFPBAydsHp1l0lL+rY9Kq9n6n3GU2VIxf1f8Rqa8t9rS5SThPSKq4h68pm0vINI0UtqMYukFkS5mxxnjffvcJ9D32EYilAab6qa1VczyOs1NDKLBClrNChVfJbIHG26Neti+dFD7ssbvtrFfe1q92/IpxGaBu6f3n8ZlH8sYqohXX3uZabzpXxNwh6q8W/3O2pUWLh/uWKc2Z1gtoYDdvZh0VJ7Uz8vRMknnM07IYjwJ9sIaxWC+t3GzYy7j+LrXdnuTMIAOdoPUccYWU6L2DJGLcLBaxt4nk+PEpqZxZ9D7O7/VF9Y9t24zy2ne80aex3aSjj/xa7R/C7QGs1/mFWluNl7iz1tDpG2D4y4WyTcG5Xn7HdJK7nWL1PPLOJsLaKZs92ga3Z/p5ja+/3Ntpoo402tgltglobW8EIG9sZdQg7cP9l7kE1tWUYoZ13m8UIG8+7P8FO6rZ7ojS8zuvOxnGvNomZZf0Tme1yBdpGG7uJYdY3MX6e5oaqC6zfqHQ728kI6zO2HcL2CWd2MjH3IJ7DEpM3ggtYw8fYtqdm53GWjRmtn8G2xRHuXBW/PDaNG1ls+iXsAtUIdx5xqo3dwdDtTsC9BCkchEng6CSCiGee/ulrr7z0l38Uzkz87aNDOZLpHAKHKNJIFDgu6AgjY2KW1kAEjoMUAmXsorqsa44tLN7HhIkVCjWNJfzFLjIb7tiw9xjQq6jnCKR1NRe7cQQWXBBKwHF8QKMibYMTGjxICKhVquhwnAPdml/83MGf/tYPvvxzRx746J+kkt04ToJq6C2jiKySf2bpt3VTKRm/wZNPPOy7e/Z18eaFy3xwrUBnl0fNVDn5IPzoDUg4gvk599ZL37507eBRTp1+Eqez2yWd6UbVOvjgysXP6Vr6H2f8JFqVyGRL/OEfvfr3fupT/N4nP3WSRLrGzMwlUqkEJvB46Zt6Zmac6uMf7drjGIfB/j1I8Q5aWQKakQIVGYRnSPkenR0pLL9PI4hIRwHdpRL5d2c4WlScklkeSvWw10nRk86QMRoxX8YLqohqAI5GC4FZ5ObPGINRVnUpKeCY49IVRjxU9Xh7tsYrY29wY28/N4f6ob+LWlgBBanABSRFV9iCM9JmvC8QTJOfL3FkepxPpvP0VoqIqIhRIZgErvZIRD4zqQTfuDyPdgWRn2GyGiK0g0CjhcaLFH4tIPf+OP9BqZtHix7SMSCiOO3xJ65AWoCf6KVWyfDjQpGvlm7xxtFeSlkfIh+0BAIwEVJFDBYDfjbMcSwQJFSEQxWpDZ4OcZVPyXW4lk3wmqnxTTVPNSmoeC7g4miDF9f50AHjGjAaXahysLefrlqZxNsXOXFjhkfw+UgqzT4T0OP4uK6H1uGidgZGGhQRVR0hDGSkw17lU7tVpcfv4IlkN3OOw00UPyrM8r3p67ybMswf7KWQSBIKCUT4ZpbejEs+m4AwViuMW5dSGh3CvsEDlCvTFEWZH16o3Lh5fSz5H/5qT5cSZYpzJZLZNB/7iZ5U6E1955vn3vrPvvDzud/vcLqpaEN3V4ZQ8dn9ByQ9vd3MFjSVecNrL5eiV1967/VTp5x9qdT0wKVL8MQTGbIdENYibn1QwTFw//GTvHvxNa9W48ni/PxX+/rS6EgjhECpKt95+fx/fPp07ouDe3MIXaRWVRjXRybyIB2krsvd2U9vbw/f+953yeQS9Pf3ggktEc9J4HhJBD4YFyPc2M2vgyMlyghcx7UikqbRBy3uPRarZ9Xrl1k43qKXEXqBxCSbEcK0/VMnii50R2GIipRtKyLCqbtajoM5PDRELdB8/7tvUZjlj77w+aeve4mAUlmQzXSgLXN1oX+Lf1qymlisnBYndQWhSzf5f/VjwqxG1Fs/Vncr2uqGxW49V1NM29n4jVELhWUpqYvPNQ1sDDsfH8bOPe9motpv0bArFNhe0sFyYsULbN7VYivi3GWW2nTz8fVgx7O7ReqaZZnCdhz/CCvryOgGwx5dFFYzjxe7hbMtzuVZaYudxab7dm98qtfvs/H33UxU+12WlkPd9rJbyo7Ps3PlOcrOksbOsdRmeAabf7uhrreWvejsKsee5fa2nSFWt+udp2GX3ky9q/fbZ7H5sjz/6/3pTqFu414tb0ea3HOZjdv88qy0Uc9yewjXwzR/H26VDPgCdn11J9Q+b/e7o4022mjjrkKboNbGZjHC5l/k9fvObktK7j6M0M67zeJZNp93v44dKJ7ZttSsnwgzRnOp+7oLgfXg9NqXtNHGqng2/gyzdJJ3DjtZbynXvUWst500MwLXjYTrxe1sJ2c2cG1dRW1sJxJyj6FuXN6o4fZF7gwD9Gaw2R3VnVjS9iPcmWSuUTZncD2F7UNOc3eW505gBNvvn2Zlv/9C/BnbQvjNdg/D+onJ24WhFudGdykN9wSsXoyLwUVoF9dICtO3KBZ4L3+yi9OPf5TyfAltNFEUoUyEox2E42J0gON4aEzMVLBqPcIYtBEIx0MrhRAuQgiEIzE6VmZaQIOw1iBvLHbr2XCPJoTAoe6uMT5twCwora2CmOwgZQLpQqQEOrIiRJ4LTgJ0UKY7k+ZwX5r3c/yfP37llT976PFHos6+A8zemrWEgzXE3+rkDWEgDAM8zzA9w6He7i4QAfsPwNXLcPy4xktJ+gcyZFJJvv5XU3z/Ff7YQO1nn02dvu9YP9VoljBSZFJpkh5ZKSukUhFf/svvfDqZ4b/+lV9Jf7wj7+InyuggwHeSFGervPqDCj19JA/uw7s0dp0fvgs93fVs9JEiJq8IjRQS4RjyKY/OoIoMAnxdpbtWpXt6hkeTOR4dyHAkctkXeKQqNcK5IjoKF8pFEpNwhLCfZcQSYwyiGuEEc+wVLke9HB/JdHI0CnitFPCdd9/n+kSazr5+ip5PKCUlz43V+FwrX2Yg29NJf1cfPZPTyEtXmZ2bpN8Y9qWS7HHzdNUcMjUXB5+r6Sxv1wL6+nJMCIfy9XESPX2EWiMlJFVE+vokD5Q0Xxw8wt5r0/iOA8QENQwaY93dxqjMFEl5Oe4jQ0QW3dnD211ZjEkjtIswNRwCHBOwL1Vm7wchT3pZeqIA3zhUXJeqC4H0uZVO8r0r71Hs76BvXz/p/YPcKEcY4SG1wdUaoWo4JkJjSIcRQ34W74fvM1gu87iT5smeDIeqAblaEbdaw5g0RvqLcl4vNB0DqFjxTGqFpw2ypkiVI4Sj6ZGSA57LUDLH8Wyat9yIV27NM5GSlFwfIwMyokBPIofvSRwlcYSwSl7GBRMQhvDyd94l0DBXgJMPktMG53vfm+Kh07Dv4ACXP7hFd3+CTw4P0tV78/de/tbLf2tynP/2M5/66F/dunqTfQPkunJZfKdEb2eeMOnz0P1K/o8vXv7622+qxCc/xd87cT8M7u2iODtDLpdjfPwW/QP2effu7eL6jZlDD5zqQgiJ50pcA1evfOD09fObx07sZWZ2nHw2QRQqhEghySKkiw6rONLFxAyw2dkZrl6d4MR9B8h1pAiiEMdN4CcySJHCaAdjJEJ6sXqiE/cxjfpv29nSTmM1JS7r3bPhtnMFIWlZ/2ehllwrhFgSdrE8tywubcOR9bohFimFSYxI8vhHn8aYH/H2W1fee/ChKlFYxPHzRKY1SSv2Erqmm82FdLSxIUjqdaTpJaPY8dkQDdvAaVrPB9ZDZtuqksl6MIadZ48tO34eO96tE1A2m46zrG5jHaFBFNrIvGl4jXNj6wjjNA07yuL/F2OI1mPg06xcyB+j4cJ0NZyNw6wr1J1n8xubztLI1/oz1L/XIvSsVa/WUzfXUs56npVzmWe5s+bIo/HnOWw9HKYx322WP6dZm4Rzma3NA/Pxp1UYBWwej65yfBhbNltpt3W0qguX2Xllq7ENXLuRfH+e1evvcHx8aINx17HettMq386wkjz0y9z+tnOW5v35eRp9WzMBgeV4kaVE3iFWt1XtJAkSGn358LJ4hmlenmc3Ec9ZluZL3dPE2CbC2irONDm+XYqIZ2ms1Q3TvD6cw/Zh57Hvh7VssLe7DbTRRhtt3FVoE9RuPzbjbmytweRmDAQbeYGeZuss8z+I47zXXtxDbH1y9Ae0Nih8WDHE1ol5v0ljgr9ejNK8zW1kEf0sDYLcEA1S0EYG1q2INxc2EE6Bjfc9edZ+3s30Z20iwc5iGFvPmpXdM/Hn17E7G8+wuTJp5Z5zI4SxEWz/NhL/Ph+naaPvqGbYyXfOCBvb8dxJw31zG5tHns2RmnZCVXO38Cy2zW4Fo9h30Z3UB7fqq9aDQ9h36vC2pObuxbPYvGzWH9X7/d/B7vg+s8l4ztO83x/aZJibQZ47w4XQPYOZ+TJ5T9GTcdDVKj967ZXPPPXksX906vRhJgtlpAKjFI50cT0XpMT3HWYKBYw2JJNphCOhrpiGVTWrVkq4jo8QgT2vPYQQlgiyQGZSsQpR/cYG2UzUSUILxCoRH7eHjV7Ewli8gL9wWC5cJ4SHkSC1QEiD0lZxzREGYSQ6gHwiyVMP3pe//P7b/1Wnn/qtmYl5BvoPN4I12rrxW0hAHIuxCkz1JOgoQrhw/Aj9KoqYmZni9KnjjF9/l9d+MMVjTw3gexGJXoe/Npzi4OHq3xF47vitChNfu4yfhHxnlls33uDWDZKvn//+bx4/yTM/9Vk+0dsPA4MeQRBRqxapzGtK8y7nL2j6B+H0qVzKaI/5YpnJmSrFedABFKaK9Pdk0FGA6woCFREGRY70dHKkUqF08wMe8rI8nM1yKJslF1Zxggq+iqiFjn1UV4ILmkb5aRHTToxALiLMgFVC8oVLUudsxkQRaSfi4aTHftfh8cDw9vUCr16Z58b+QS4f6qSQqKunObhY97PF6jxFFTKXMcye3MONmVnSkzMcLIc8Ebj8RGR4MJWjNFWhoGu8Gk0yufc41YQh09dPTYNWGuPB4Xwv4htv8JPJPrzaDFWKVANL1llId/1bCoxR6HRIefYqe6Isw739/H8Xx+D0CarJJEFYJSnAwYBQTCU0Xxt/lyODH6EnUsjIMJNK8Jop8FI0wZtlTfD0UQqJJFqkCOcghU8kJFIqhFRIHdKbcFFzM7jvXOGRMMEjkcdxmaZHa9KEuCpEGQ88cGIi30JTiF1ASgNo0zjlSiJjMK4AbXAwOEIBEd0RPFISHPWTPJPt4525ed6drXDTmeQDd5KjA92oqIzje/guqBq4wuXqlYDxW9DbA72dcOK4TzqVymazPXz7W+/z9b+CRx4b59DR/VRVCR0VeeC+bg7t4+NXLhW+8taFV75+8yrn9vSS+O7X3mBwMM34RDlut8gvfpF/kEgTHT0OXd0ZivM3Qac5/4NbpLJw+rEhpqauEwQBJ47TH4YhnuujDRgjmJkppvbtSe7bs7cfUZmlVpy15Wusi05HpAhChed7dORypLo7+ea//wqOB4eP7GV8/Cb5rg5c6eHINBgXIXyQrg1DOggctAAprcKjg7D9XF1nrt6Nxf8Ybfu4BuFsJSlNa4O08pT1XiV2G6oxRtm+SBu01mitF9yuGq0ROloUmEapKulMiiAIyKRzRCqiUqnhCkmkBcgkc8WIB0+eYHpi+h/9+Z++eu7zf/OTXzEyQsdpaKinrc6W2rBq2ZbuX05G1rt8/0ps5f716cW1ukqDnWs/z9p2yedoPs47x8ZtWTuF+qaLnUKdzLARNLNHfIn1L/QvtluMbjD+OgybI5iNsf3z5PrzjMbfrQhql1nbhnSatdWQztB8rrsa0eCXuXPt7HWy11rt9lmau66ruy6tE8O2gmFsHXl2k/fXyULbhSFsmp6lodh3md1R9FpPHsxi6+N2kOXqBL/N4jR2faKV3aUV4WqYle33TvH2M0rrNbP6mswZGsqi0CDOno+vOR/fvzwPVivry+y8Z4xRGhsyhxcdbxXv2Q3GMcJStcs6Oe12rNsO03z8sR39Vx2jNOpJnUA9FP8eY2UdWuu9NLstqWqjjTbauIfQJqjdfgxv4p61TBrPsbOTqrPbFE6d/X8v4SzbI2N9lnvPndFqu9s2g7NsTGFlbI3zz7J+g89WjWfDLc6NbSCc82uE1Szur6/jmjbuHIywMTLxr9PYTb3RSegYzSeQG3UjcobNT/DX2i06tslw10KezaX5l7B9271G1t4urMcwvRruFAPaZpBne9Leia17I9sQ1nZgmK2T7sD2NyPcveW7VTzPxvLxN2moa27U0DdG8/59eINhbQVrxdXuX7cRGsjmezDl61Sr03z7q/9u78Mn93/5wQeOyEQ6RVgzDPR0MzM1jVIBuVwH07OTFEsFenq6mJ+fJ1LzOMoS14QrkdJBG5AYImUV0xztYaSOiWySxWpbQsQktQXChiVlmPh/S0SLlX+ou8+TMRFHxqSJVipqLgYNuAukI7RCYDCOQRiNUhpHKAb7OnngvvQ//M63vv3Pnvz0F+ZD2VAHEnVyWouZuzTgSgchFErhhFFINteJdOCzn3uUF198lVe+d4tnho8QhGVSKclHnzruFufLTBduMl+MkA5cuVLEdeBnf7Znb7ZLnPESNfxkgDI1jK4gcRi/Mcl7Fy0B7dRDLoePp6nW5qhUIJ9Ps3f/IEm/l6/++Q+pVjQSjzCskPAE0jGEQZE96QyH5gscSO3jo5lu9gQRyWIRhyqBG8VKaQ5GSLSUYFyUkRhRd4loy0g0yRSpJY6pEzg0STR+uULOMRySDkfdJA929/HV6RmqpUnk3l7M4B7mgWIQUAlDG42rmZSGGWlQGejv3k91LmDy4nU+mJnl8VSVod49fGXyCvMnuplKw3x1HhUJMAkQEleFmIkpPiqzPCZTJIMibiIkClW9gJd+I0AoJAGedsgEET2ViBOpBIXZeWqJBBBRMwJJhBYR064hNdjJS1GBnoG9qGKJF6/8iCt7Mlw7mKd4YA9jOkIJSSJQuCpEG4FjwDMBmajKoVSC0g/fITs/xxOJPB930hwNNAOhxA01kdAoWW9Hi1vyyvovhMDRtg6HQOiAirmevmmUXTLSZJSgs6aZHJ9nsKubhzpzvGXmeacHBrOaKCwiMg5SGhw0ER4COHgQHn3sCImUohpME0bzVIIqn/mZR/jqV1/j7YuGKzc/4Oh9Dj3dPSQdl2yXy2C+m4eO6U9MjM9/olYJqJTmmLpZxnch1wHdPT7ZjgTd3Rm3UimhQ0FHrpev/vubVCrw7N/ciyHCcSVRGBIpHM/zFp5dRYp8V7I0N1e9dOvWrWP9GR/P8wjDEIRAG4VSCoEXE88c5m5NUpiZ4cSJAebmpkkkHRzpIGOFNaMkUkoc6aK1g0Q0KGSikedLup96/2SsA0fL4zQLCmjamEXuQImvA63jhhO7n0Wr+HiE0pFVKNSWXCW0QQphu0gnJpUJiRYCpEabKplsimvXLpHwUyQSKaRjKaCul0ZrKM8X+ImnPyaLpZe+/OUvf+3Q5774C9enCqVlz9HGXYwR7EaGJTDGzNJQAd8wLOncLHyvdv5DgqFVjtXzbrfTcKcQCRcjv8b5M+sIo27THGV1W8CXaE4GGmJpHb6dRIztRJ14tBr+PtuvJDa8zeFtBWM0lLPyNDaF7zSGWJ8L22e5c8iP9bZzntU3eX2J5m1wuS2q7v5xdLsSt0XUy/wsa6/7jLLxdI+scmyzJM2N4gLW9vIcti0/S3NbzEbI0LBSbbNO7txIGxraYJyt0KqvOrNNcSxHga3X47v9HdJGG220setoE9Ta2ChG2D5f9/faIuIwGydqNMMh7r28W8+kbz2o5916J+drDTCH2R2Dz1rEm/ZAuI3FGGFzSpeHsJOy02yc9NhK6nojRM6tYHiN8zvVTp5j8wo+9yJZezswwsbr+IfB+Pwc20PWBttmz3BnuJk9s81hnd3G8O4WnGVzbl9P0XD7tBGSWqt+/xBru43aLqxlFB7bhTTcU4g0pFIunilw8KDzV08/fdj1kzUCBal0DuEkSCdzlKvzzBZmeePCBTo603iuoTg/RzKZRMi6ipgDjkQIx9LJhFUqMkoRahUT1Za6g3SkRAiNEBK5SJ3HGIMxUfyt0MYSNITj4rouEh8tNAhjVcwWqCKLiDpGwoLil0YIcKSPEoE9LxSR72BUhFAVEJDKkfKyfL5K+V9XVcaSR9bNzZBxftRQipvVSpW5uTl0UKMrX+bZXzzGn794kT/7f9/n5Mk0Pb05lCqQyYd0DeTwPA8jHKLQEAYuWhkiE2HwMNrgCJ/335/n+jWoVqC/B558cg+ZjKZUvYXjQL7DRzoOiIBaUKK7u5srY9NEGqIwwjcC6RpUrcLerMfn9vaRn3bJhTPUCnMk/QQGjWNYpAwnkdpF44LxABcdu2d1hAITLcr/OjQ69uDqGFsqQllym1bWg2cnDodm5/hbmRxPBkm+e36CH6anubG3j4mD/aR781SmZ9E1qLoRypeQSjFenGHKlew7tYeJmQ5GP5jiUDTOfH+S6wlJoVqL0+OC9khKF7cSwpVxHnE7edjPISozaF3CFWJJnRF1IiQCqRV+KBHGQTkC3yg+SoZrVyao5lNUdQVjPJTR4Gim0aT2D/Kn71/n9dIHaAxzp4YoZX2qmQRzpSCuSjVqJqQGIB2SUUR3KeDgfJmeyzc45ad4KDPA3ihBZyRJaE2oIoQBX0kkNv9sLjeIgktyX9h8d4zV8qpJCB2DMgYpQSqBNJJoQeJLAZrenMvM7A26vBSPHU6R3OMy0CEQOljiytHEpsdsByTSFZBlQjVPZ3eWWtUwW7rM8GeOMT0zyddHC7zyPUV/3zgDAyky6RwdaZdUIuDYiQgpwOhuHNyYDKaIogphqJmbqVEtJbl+vcyNGzfxMvBzv9ALaC5dus7AwEGCMKBW44bv+zjGwfNcgrkiewb3mauX3vsX77/3wW93nzxCJpEijGoYQhABCI9UMomODAKPy5ffpVw27Nmzh3KlgO/7MSHNwxhLCjRaoKWwrj0NCCcW/Wsio6W0dYvrImx/piVGW1VILUDFWmt15TshRPyRaB1iCDAmbOS7UWhj73cMeDpWaTON8/XaoGXE7NwEvu/i1xLMzRWYmR7j8cc/RrVcJZ3rQiZSBDVDqHxy6U4++Ykn3A8Ko39VC4MHMrkujJCYmBy3GAt1oc1buxvwLKvPsWaBYWPMedgcCdFxnAWCmtYr3bg6jrPKXXclzrPU9nuBhrvQ3cJQ/H2IBpHrTsFwi3OXWf88rk60eYGGLabu0rGVvfcFGvPpF9n9stkJtNq4txOb8wpxXEPceXOtugLWbmBkHdf8LndW+4Olblbra3x1t55nWty3uK2do+EB407BaPx9CPsc20kKHmLleui2uDWtj+UWY5V37Ggc/5n4/+0icdVJh/W+40vYfNtIn/hcHOdG1xFWwxmarztvlHi33Rhe4/zoLqShjTbaaONDhTZBrY2NotXgri5Z/AJ2wHAaO1htpeQwwr2ziLjWwPi3sHl3Hpt3z9Ja9nzTOxfvQoyscX4zebddBLURdmcn5FpxjO5CGtq4OzDM1twwd2Lb01ry1YuxnnayGwS129FO8uuItxWe4c4zGt/p2KhKFDQWBu5mchqsPQ6rq+iO0XC90YrgfYbbr6I2RGsC/wUahjiwz3WG5oare43ED6u7qdkIVnMZsRbulPFRK4LaLHd/m99V1B1vLtcwMTHpygNENEcUTfDtl7/1zz77yaGTPd0pZmZn0cLB9X2mxm/R3dFJMfC4+P4ltIZDBw+hiUj6CVQYYhyQ0sM1BikchGON8E7s/pKYoKR1BMZZlDrQxkWICIHAiKWL2cYogiCI3XxaAg1aonUSxzFI4SIciRF6CeltcQ6YBcoRsVKbi5QJlKrGRDqBkA7GaJRWDB05wKvvvv2ACiOkUHgGBAYh1IKrO0QjT4WJ444PuL6P0QptOFcJBdpxmJ2fJ9clSPiCL/z8w7z2ylu89+MyhdkyXgYSGUhnIJsBL5mkWonA+KSSGeaLJebmykxOwtwcJBJwYNDhwIHDdOYzqHAct7OThC6Ty/jMTJURxhJ9POmRy+WoVqbR2sEoqEYG6ULCFQhVIsE8lanLpESGgc5uapUAjMTRMs5BAca1H2LXhsiYfEhMbFqdJFWva8Z6lUQKGnllJG6gyNYiEsUq/X6W490H+T5VXp8PePXi+0xnsxgvTdn3mHAl5aAGOoR0GiXhShAi80mODj3CG+9PUK5UmJyeBs9Abx6kD2VNWgjycyHZqzOc6DpGuqIJtWZ6do5Mzq7fyFiwysGSu4QAR4NjNMJERLJKSsFDJsX3b0wxc7ybKWogU/b5jSYyMOFJar05rswWuf+hh5ghoIamWgkRypKOMAZpaiSjiKwK6a40iSIAACAASURBVC9FHJkNOFyo8vGOQQ7WDN2FED+cB8fHSAdpNEZYOpowEkfrBZJaKxhhn8fEz9igGlnVNVfLWMFLgFaEYY2s51HTVW5evUT/fRGumsFJQCWoYVxFEGhqQYpaDU48IHE9RRgpurs6ibQkk05RqgRUq2X69uzhF3/lJJOXxnn/4nWujJVJ+hVSiXGyWejpB9eHlJcGJ0GtVqNSKVIsRVQrcOsaFKbA9+HAgQQPP5IlnZFcu3STg4N7USJHWHPRUfSNpAOhinBdn1lVZbC3m+k33vvn18bLv/HwfU5Pp+vFLnm1LQcd4soU5SgAJLduTdLTk0MpRTLl23rhyJgQpsC4sevNOAfXEIeSBlSsoGZiRlcYWXKs7c+kdUcqQNb7RWH1CIVwMES2XxJLCWKWtGusMqSoK0haVEoN1TMtNL6XJJVJE9Tg8JEHuHr1m7z9zmUee+RhZotlMq4kCjX9fQeYmb5FV3+Oz/30kyf/8IU/++2P/eTn/4EyDgoPLWTdaSlWec/Wn4gES9X7pE2N0HEexGkTK/uGhfxb0XfLVf5bHXqVPmdpSK1D0C1+ITSIhptWYEVatVgWfv38Op6/WZh1BKIDJW40v299aKbAdAEYMcacry+ab4agputky/j7Q4znsOPqIRrzst3G4vHvCHeWrWG4xbkzGwyrbgOuqyWtNe4/i533nGPp/PJuRp7VyWmX2bmyr+fzMPfWnHsx1mMHrK+T3YkYw5bfetvOGazN5k5uOwUs6fQLWHvhKNtnh15uc/gSu1v3z2KfqRN4rcV1GyVxPc/W+8SxOF1bJaidpvla3p3QltZaI2nbndpoo402Nog2Qe02o7TIILQaMpnMlsIvl8tbuj+dTi/+OUTzxcDVVEnO01go/ZMm9z3DnbnjZluwaAdEnuYLxM3y7jw275q5VTyVTqd3S53itmBR/jVbdF1NTnpx3i3eGbcYG1X2qE9wVkMnO78QnmeVBdhlRr0Vz1KpVLYU6bL2v2Fstf9pY9M4uw1hnEqn02dY/wRwFNsemyk7fYGd7+uHaa1idm4jgW2g/q+laHUOWyatSINnucfcNqdSqZbnmyxa5LH9+jMbdAFzDtuH3jU7o5s837M0r2sX4vNji46Nxp/nWOamZ1H4a6lP7QZaGXZX28H5Ao1do83GB89y7xjL67tet4qNKhuPrnF+BPsOWdHu1mq/a/UPy+Jo1f+OrjegNiwc4L/8u5/Go7hABohMiOcnCQNJUJri4WNZ/uB//tbHfuFz+/7+gyeOoANJR6qfqiupVcuE5WlKIqKsPL75yntzDx7p6Lj03gd05TtIJhJIKXBxSXgepXKJoFqzEQlNRyZLUKviuC6udNGOJaEZIWMymgStMUiUWKyCZmGMQemYHCICEBGOliijMEohZAJpPBzHX3SXJU4sCEPVlYlM7BJ0YSFdIo3Ej1ykNoQYIuNSLVVICMo9fieVyPDJR/dYpbZ6mkSsYiTAEDA9cc0qMmFQgNET9hrJxZd/UPv2g8fDp4f29TJVmCTIVMh4FU49MsD99ztcfO8ytyZhegqrWJcEIapIAYlUBKZMGFmvf0kPsv2wb+9eQFIpBlTnKigTMnljgkgpEglNOtWFn0yScjK4iQ7274f3373MzHSB3sEEYVAj6YOXkKikpuPRQS6N32Qg6qEyUyXhJheeVQIIgTAyVsySSCHQwhL2VhLS6i4MLSHKxIQoJVjEkoxdGMakG0fGKm26Rq6keCLp8hEEz1QM70wX+FYwzvU9PdQGE4QJQ2gEhAqEi+ekMcZwZWqabGeSZG8H3IigqGB+AvJ5SKZIBAGHbgb8ZGo/eZIUy9NgDD29+5gPIqQBB4GnrdKVFjbNRkRoJ0LqKg5VOqMyx4IOHnNd3nr/Cp3HDzIfKrQ0VtLMWEUsskmIAi7NjFMzAeDiixyBsoWcSUjS5VlyN27waDngEeXzoMhxUObomQ5JRhrtGrQwmJhIVe9ng5ikVlf20wvkpZUkFyNA13lPgK8FDoA2eAgcYxBagvEwQhIJ8B1BlRqhW6YmauwdSOP5ZRKJBNlsJzqchVBQmCqRSEJfXx+VWoDrpoiUy+REgaBWo1INUUoi3XlcOQG45HN5Mic6qFZrzBaLzJVC5t8D34NarUy5VCaoWe5jwgXXA8+Bj5yEj5w4TLIrC9UJ5q5N4GqozpeZnk0x9m700v4BLl7/4G0UPjpWYpu7OcfHP/ex6Jtf+c4/HHrng39lDnSR8SSONgipMYCSCq00WoFWglpYjdWgIpJJf6GOCwNSGIQ2GGlALlVsrI9zVVzPpbbhC23lzYIoBBGhdRWw7nMxEqE9hHGXvEeNAISDwsQqHA3XpcaomAwESgdEogo6jFUkwU24OMISg7WQzEchN6ciSvMR1XIZTRcvfffqbCaX7+zszlGdvkUm1UWkDZlcF4XCDe4/fICf/yn9X/zT/+nP/u2nfu6pb4tcP8ZNU6xFOMLgC01SBWh8/tN/8vtgls2xBA1C1kLfuYrC5QIWq16u9ntx2KuQyFphOflr+e8lwxe98veK/9cIbxlBbV3P34SgBj7/UqRXv2edyGQyz9MYV10AzhtjzmqtR+vKZ8Cq6mfNUL/WGLOgkKa1RsrNp3Oz2GX71OhuRgYr7BeLx9/rmu9t1X64ATRLT0v1tBblV2Ad+Z1KpepEnMOsYpfaxedfFWvVzxb2qRXtFjtfXkLM2eb1IWisZZzdUsDrxBbyZ13nN1H+I6ytbP8CcVu8Q+3jC21njfn3ENbm8AhN1lFud/tZhBdorN+cZZ2kqbXSn0qlhhb9XOEyd637m7m2bnX9MpzH9pGtbN5NXUk3sb8MY/PmcKVSGWuVnjXqx2j8PUITQuA67Ot1W++qMMY8zxbWE9ZRvmsFcZr1tfc22mijjTY2gDZBrY2NYLjFuRGak31ewEoaN1M7GebDv4g43OLcGZrn3ShWHazZDoLhFvd+WDDc4tzzNDdEjGLz9neanH+W9efdKGsr0JxdZ1ibwVoEmBe5i4gXbewoRljb1eRl7MRuLZfDdaXB9datUVq3kxF2dsfTWmHvxGRxiLV3TZ6h0R81K5t7UfFpo6jv6N+om/EvcfsVwrYLwy3OjdDcYPM89p23Wpvv5PYr+DXbiVg3sK3WBxXic81Ie9vlFvxuwFpjBLCLFbB2+znDxvqh9RD4n29yfjtwZo3zbSPhBiEAhwCPMhChhSblOtTCEmkny97+DEk1y4lD/PF9x48QKo1DAo2LMBGuUWjfoxga/vjfff3yzTken391riefmftr2dT4Sc/jYcfhcF9f9zGEZs+eflLpJH19XcwWpgi0RKEQWiGkAu0gpEYYiUBb9RkjY0U3uUKRyHqWE7GSjSV1aAxog8FBKKvm5aCt0tGKHFhOeFNoYzDaoLVBxh8Rh2eMQ3GuyuQEL4flAMdx8Ex1Ie/A8iU0BoNaUI6pU4QEoAxgBEIYpOJXz5+ffjObztPZkWd6pkAtMUU6kSKd6ODkA0c4HjnMzBSZK5aQ0sV1fKZnprl5I2B6Gjrz4Hmx8JyGC+ev27hiRTLPAccBpcB1y8AMSKs45TgwuOcg1QiCKCKXHaBQugnYc4FbJXmgk47DaYpvVkiKPHVynyAm0NSJhMhF5I31kRnqbgDVqmsoDcRaeiRVQLIU0CsER4TgmJ/i6MAAo6Vp3rg4SX9fB7WeDgoaiiqiFFURjgueR0lqSkGFg8eOU5ydY3ZmGnX1BuRzOMk8nYFhKNONrBqU9jAmRBkPg7b1TsfEtPghrTqZRAjrltQ1EZ7WDPhpHtyTRs6+h1uu4no+IQIZK/UpDMZ1IJ2gFpVIdHVaImTo0Kk8EsUK3tVJ9lbneQD4yUSOYxU4EAnS5QCvZvO2KgXaicuBhutRLdZW7loopWXXCqwqnNAgxFIipwIcHMBFupp5SiT3+GTz4DoBnpfCGMFssUYu00WoipTK8Pa7twhDqFYhiuoFDyoCrQFZQ4j5hTR4rq2b6ZRDpQzzBSgayGTh4MEMniPxExLfd8hlk3R3ZahV5nGcEuHcPCqsoUOJgwInzas/usEPL/KrJ09mSaWzzFWqaDSKCCEhEILhzzzyf1y88Np/f3R/vtdmhEbqEKNDIhMgHUGkIvL5Lm7cnKVcqpLKCoIgIOGnABPnl808q4qlWQ9xSBtl+y0dggkxooYwNTD2fqEWKZAZiZC2pA0SIVjU/kAbg9YRyoRoHVlirAkAHRM9Paami9SqIeVSjVKguDY1c7ESikthRbweVvWbYWBeSiaY+t4rP/7+8CefOpRKgiYgFAbHTeCESYJKlfsO9TP8FP8mlXb2T5bLmJTHdLFEV3cXQkd4JkAbF+gAkW2VA/HfZgStpb/lOuv28vCboxUhbeXv5u+QWBFtjfSvxDqev8UzbwPla7jVyfri+kYIaovvi6IIKSVKrXQD28aO4Bx2/teJnTPdCePiZ2luEzmzw3HXN9F/2DDC7bF3nOfO2Ox2u7CeunQntLntwBh3T9s5S8P2WvcOMszW10zyWPvUCLevXJ+n+RoXNNkc2AKjbI8dcLFyXX0dYaM4S/N3Q9118+3EWn3di7uSijbaaKONDxnaBLU2NoJmC4gXWHtwdobmBLWhTabnbkKrvFtrkHWG5ouPa8nLfhgw3OT4euR9n8fm3WqD3GbhroYXaD0J2ElySZ61J4IflklvG1tHq7qyXGEpT+u+uW7IPLvOuBfvVFsNvxmHNdbims1imLUJdzvRTs6wtnra6KJrW6moPc+iHZZtLEG9Hq5FwlmOX+bDRfpr9s7/EmsTrp+juSuA09xeglqzttuMnFZHnaTWrF2d5sNP4ofWCxIvxufr+VhXW2vWVx9iYwtYa/X7Z+L4dqJfaza+W4z2+GiDMIDSeSIAZw5pAsLQkBBZdOgzMzPOH33p5f/u8z9z/z7jZagYB1ckEWg8EwKa3sFjvPCVb/HezeDTj3/0iclg5upk1hdvW+UUl3Sil6+/9MohBKc68oUnsjn58b7+zp/o6cqJ7u4Ee/sSaFUhrFUJqzUyqSy+4+J5CaSWltATK1YtV8sxWoL2Y/+QyioQSYHAt0Q1oxFRRGQknvGQrlygAwCxK8k4MKExWhGZCEWEkRFKKyIUQmhCIDKCK9dvzfXvdb4RCYX0Gov2dSKPrv9vrEKYqLuAq7uytP7tMMIgJG+99ip/QwWFP/34M3vZM9BLbX6cWlijWp0gmaginRx7Du6jq1zijdffojRn40knIXsAkklIJCHlW/eeJ476sVKNRmtNGCowDkppEn4GgcfcfIWJ6QqlIrzxxhXGJyCVNNx30iVOulXOEgF9ewyVgw7jF+bJJwZRyuCYaIGEY4RoofCzM6i7MMyHNR6Zm+X+dJIPQu//Z+9No+Q6zjPNJ+IuuVdmrSgsBAoEQYKEQIA7xUUokRQpyVooH7tleTRmqd3u9nTbLdpz5sd43Hapl5nTfc60qd7GdmtaRY9ld9uWBVmyZVOSWZRIiTsBgiAJgCQK+1JbZuV6t4j5cTNRVUDlUhsBEPngJLKq8i5x40ZERsR94/144Z0JXjs5xaneFNnuTgrxOJ4v8DxFQECgNafPngUpsLsy6HQKHJf88TOcmargDazFK7hIZYME3/WwJGg8AiMUaQlRFarJ8L5q38bSNkqDwmS6rHDicRSSQqGA7Oy6KP2mYeBGIlDI4hkpDKWwjQJrij7rDx7npoLLrekEN/euQZTKmL6HU66ABtuqCtHkrMAPGmlYakKpFgUmQqONqrudoBq6VeEbFUASpRPPMpjiLJlrDWJdBkqGIi4vCMh0dqMDi2PHp5nOgn0S7EhYTpNJWL/WRhphHggh0MH80H+2bZMvFpjOBogIJDdANguuC6fPFInGoK/PpL9vA6mOFNoroKVPrlDCEAKBRaZnA1OTWZ5+/hQ/eIlPr795w9tFIan4oSBPohBaIfFJdJioUkBR8ZdnZib/cWxNGku7CAOEtJCGjSVsfM9l7dp+TpwcY2amQKIjRak0Q8ROV/PWWCAvm4vUQuGPCtsw5YfCXO1X1bcSrXxCka1ACANDCYQIxbpSq7B91Bp13powQBIAPhpJJNZBNlfkzLks09mSHjs+82zZ4UelEi8WHPbdftfWo7YSaN9ABAZuxaEjGeXI2MGHXnrl0OF7798GUYXnBgRaYEfSFItZYhHJQw/duf7re577Nxt33PZ/KFPT2xNB6yxSKhQVlJJVJ7jWil6by5PzIWOXEKKzJtKGlkVuGeaPf/ZSv0+5i/kPkMdoj60vdFG7HPrF9earGrqntbksyTIb1u/CMffgnJ/HqD8HOEBYNjNzjjnC5V9vh2k+Ds1xedS5q5FhZueIdjIrUlsOIzSfn1oSQoiLXEUX+I6szd/Xo5Xni6tJbV5ouPrz2CL2HabxnNKq5PsiGWryebuut2nTps0SaAvU2iyGeg9GR1vYN0vYWVrIuWFwiem5kqiXd2Mt7r+XhR/gDiwlMR8QWn3oPEbzgWMrx2jkEgKrJy4ZobEooz3obVMjQ313nH1c3A7VxB1Z6rs0LkagNsL88AL1thls8XitUhNcNOIZVl4YN0D98II1huf8PEI4qK0nxkkT3o/hOp9frTxOY4FwPeaKAz8oZOr8fayFfRt9Z9Y77qVmbJnbXK7XtZLson4f59tcvNIzy+wDqnp9mkEWJ1Br1O6nmV1osZIM0LytfJJLP5F5RRIIG1+YGEKhhE9lxiXT28nU2UkOvHJ4/ec/2fVb1w5spOgbpDp7KBVdDK2Qof0RTz39At996sgXb/3Y/YfL2sCK9aFk6AcT+IqOZA/3Pvjxo5VK4WgyZf2V4+X40Y9fHUgkpz/eneHnuzt4YH1/ig3r+uno6iIolnBUgOeVsSwJsuqctoAzlFIGKjCrD859hAzQCgQGQgcINFro0DFJ+JjSQkoxR6ozJ2SbVggZoLSLxgvd1PDwcdBa42kTB8mxc+pb9wze52rTxLRsVDWkYg1ZFabBnPfaf1og1azTFcDnP3/Pd77/1E9u/e53T/2HrVu4b8vGLhJxi1TMwHECisUZXnvlBFO50HVq3VpIpqAnkyGRsinkz2HaELOt0M1LV92YqsRjBlJaBL5CCii7JVIdglQ6iRYWph3nrYMnmRqHM6cniCTOXwkIFxnN0bEWJnoFQpkE004122ZDGy7OW2flsANFslwiKGvW20m2rtnIFuGwzy1x+OQ5TkUtpjt7yFomUmsQCkf5aAWeD7ZhkozF6FjXy1T5FN89/iZ0bmRLLE7GiGPks6R0QETNuv+oasgcqUEhqUiDvGlSMiUzEZPXJid4K5fHy6RwSmXszmqZCKohHYUg0BohBToaRUycI+P7rC343DDp8/FIhlsiFmu0Ijg2jidNdFXkGEioiKo73qI0ga25ec3boxpiUlfrnpY+aIkvPPy4QzbI07MhShAJiNg2hmkwOTENWlIpe2RnYPuH4Lqt6wi0SxBUUMrFNHysiCQeMZGGRHsaPwjOp08FFRJRjd0HpgmOA1u22Hi+YmbG58gYHD/h8+7RMZSCG2+06erqwYwlyeddLCPFGy8d5wd/X3r2+Dj/fNOt/a+JSCdOuUQQOJhGACoMp4lW+H4R1y0znuPbp7O5f7x+XTcoH4MAAweNg2FZBIFHJpNBBZpSyUVg4VSC89+GYXuhMKrtVCuR6UOXRT8UzKHAkDgVr6piDYAArRVCA4aBRCCFBBG++zpA6TD8aHBeO1R1M8RGCZvR5/YyPRP86Nw4/yM7w9888ODNYwobjYnCZCqbBSSmMLEMEzti42PQ17flnVdefeuLGzdn/viaDf3YxNC+IBoxUIFASoMN63u47eY1v/Xdp1/5z/d/4vZTFR0hkLLa4Lmgo7TeOrz/4R9Xlou905ZyjMuNmsBsqQK12jHmvjdgmIUX6n6Vi/uVT7DworvHWRnnnCuVvcz29y8Hp6tHabwwqc2VRa18DTI71zDEwmPDhVzth1h4odkwLYZlbMBA9TiDhGPlo8xGNVjOcaG1ReTQFlxeSkYI71Ftfnw3s/OxS2V0OQlqxFzxdh0y1fM3mmu/1G3oHsL6XHOta9VQY4j6zyMgnNe91M+8hmgeWvVSp7FNmzZtrkjaArU2K0Grg/2rdVIA6j8kbVVkdTXn3XKEkbXtmjkrtcITNBaopQkHPCs58fN4k3NCe1Vom1kaDQAbDVafoP6Aq9VB5dxjNRpc7mbplt/1GKG5CHVkBc9Xo9k1fJuL26lh4OkG+6ymy9yVRoYwj5uJAOuxGzhCeB9G+GBMGNQToI62uH+9hQKXksEGn422sH8r23yQGWzwWaN2f4iwnVmuO2+WsG41qqdfJuzvjiziuM3YQ3NHxZU831WDAgLDRYgKGCUMyphS4JYnUcEp1vTxBx8dvCsUUQibmVyJSNTALZVIRExOnprg4Dsnntx1543fkFYaD7AsRaDd8AS2T1HlEYaGWEBJBwgryn0P3D0m4fcl/u//5Mcvbz9xJv+Z/W/mP7tpQ/qu9Ws66UxFiUVNkh1x8oUcTsUhle5AKE2hkCeT6SSbnSaTXkNhRuF7HtMzk/St6araf4WnN4zwgb+QAlFVjAghQq8jUX1orlQ1xJ5fFdE4aDwUAYbw8YWDpwKU1c3rr79DyeFrntYoEZAvToUP3XXNd+wCVyshkLoWok2F4UPPfypRWnF2vMLd99zxmm1x/54/f+nRw9dMfWldPzt6O2M9pWI55XrQ1QUDmyzSmRi25SNNn4hVRssyHRnz/M0UCCKRGKZZdXPScjZEm9ZoPKwEaO3iqYBAGYyPT3PjtjX87XtnOXmywrVbBZ4r6F+7hmOF44zPnGHjjVs5t3eK/c++yi2Z7ZCfDf3YajjJOVk+D72I/S/ER+AgEAiscgnLrXD/xj425R18I86PsyX+8Nw7TPZ1YcXjCNvEtE18odGBj6t8plRAVvqkNqUpOz4Hp0+wRdvcafVwe28X2/JFZC6L7wdYlonwwS1XiFg2dmcXR12Xd0x41Szxuj/NiT5Nua+DyaiGYhE3l4VkirDU1cRDIWk00WNjfDzdy0dLca5zI/T5EAmc0NWQKFYAoAikQhmzmSW0RmowquW6dp9FK8qoBszuL9BSE2iFlioMT2oo8iLP8cJ7RG6EG+7q5/jkGB3RNLZtEo3EcSqCkycqKAX965J4ahrTUtgxiWWZ2FYYi1arClIILCuKEMnzeeN7PrbrEhBg2zZK+ziOR4CmuztGLOFjWDGOn5zh4Dvw0psuWp9CQ97zYhOnTpzaX8rz3+4ffOjbd0SivHJwP54/hRAOWjpo7YHhhiE0NThOmWSqAx3heyem9MGbdPQGJEi/hFOcJJq2kLaFBlzXJJVKU8w7aGXR1dVHoVAiEU8hDIlWGq0VxhwzNYUfisqqv13odReKfxRGNUSoQmNZJqfPnEFITU9PF4l4lEqlgmlZeJ4T3m9AGSClxJARpLLwfJOpyTLHj53l9Impl2cc/rISld+5bvuON9ZcZ6L8AGHFsLSsCiwFlraqIZsVgfaQIhQWW1aSW3be+I1v/sVbH/tn/7TnsURKUfYclEogpYXreiB9bt12Da+/fvYP0rbzaZSmosL7qKSL1j6thticDcB8gaNIqwW3Zebei5U42gXHW7KbpLzg/apjkPpzCl8m7OPtnbNtPUf4nax+uPnLmbnzzZc6zGdtbL8Ql4MAoc3iGau+P0p4bweo72z+GOG4faT6e6bBtrUFTkNLTNcAYdmfO1bcVE3DIOFYdzlz6AsJZxfiam13LheGmB9B4LE5f78kCCGWKu4eofE8Xo5L/1woSyhEfYwwrSM0z+tBGkcZqYVUvdQMN/l8hEuf/23atGlzRdIWqLVZCVp1qLganCwWS6sPAa/mvKvXyRtscf9Wt2vGKM0f7n+W5a/KqTFEa65BwytwrjYfDBq1J6MNPstWP19IYLBY98ERGgvUICzXNev+5TJCcxHnaoSLGGzhvAuJQ0YJJ2AbiWaHuTwG4ZeS2grBlRBTfbb6yjHr8je2Ase9nNhFa0Kty02c1oxBml/X4Kqn4vKmXv9wH43LeZaVc+cdprmQ9Inq+VpdmNGIEZqX5Q+ig+L7ghYQSIUQCoTEUBGS8Q6E7xKR5R0f+9g1P6OEj9TVx/BaUcpniUUMCiWf7/3t88eSneuH7EwvM0qCMMKQgLrqrgVILRHoMPScrrnrGGF4UQwe/vgjBwxDHSgVZv6vp//+hVsz6dxn4jE+1pEwb9+8sd/ORDWW9BmfyBKNxjBMg3J5nOx0ltOnshw/mkVK2L5jACkESgnmPuSX0god1YSxsHhH+Cil8P0yvl8OxWk6DBeqjQDXqyDtCI4fcOJM9r0HHr7tWRlLMFEqorxqeL4G+LWkiGoUPz0rylICoolOlFA4AXzqc/fuSUXZ8/WvPbexI1l+6q7bueG2O9YSjWgsW+P6BeyIJJ5IEokamKaJ8hSVskul4uBUPCanZubcYAgC6EhCd3cHqVQKrcsoJFL4IAWbBrqxzTTXXnuWEydgy3UxyvkSU+YUXV1pxtU0WeckG29bx8yxPOXpIinZifRrgppGhNtI3SgE5TIQCiXD42sBllKIyRzrXJdIPM4JIphBAQIfr1yEwADfBNtC2hGU9kBqlIScISnGo0S7YxRyHqfOnOX1XIV7zBi3ZjpZLxNMn5sigiSWyTBlaI65Zd6SPi+WZtgfg9LGXo5RwY9JwAdTgg84LtqOhkJGOZtjhlZkDItrjQT3RzpJZ09jGAGBkFRMk0DMhuYUQlySSIlBNb0GJp70mTBzzKRm2HKbzYx3ingqdHNTykdrjW2mmJqcZsfN0N2TIpEyw7qkFVoHeE6RSsWlUtKUSlAuFVFB8XwYyDVrogDYtollx4hETQzTJxIEuL5HXNqUHJe1axOsWRdnMq84dHiSF1/k5JmT5YeH/ufB41plsO0efBFgeKBVcmeV5AAAIABJREFUGaU8NF7oVKbl+Vc8mSGbzXPnvbv0T0b3fvhbf3PgzU8Nbu1PJFPYlqDsFDARRCwbrXxu3LadF158jrNnJlm3rg+tfDzPwxTVuKg6dD6TQp4P36S0WrgCKHVetKnniFwrnkuyI8WbB0/w7vEZdeO2ASmkxPYlpVKAqrlJaslMvoRWHhOTOffkiZmXpyb5fjzGX33i459+tRwEHMtNYsWjuMUySodhl2tIbSKUiYEMHeXErCui1CZg86u/8pmh7z/1V4MPP3zXplQ8CcoNBbBaIxSkbcmD9/Z/6oev7L95YPu2100jGbYKuirGXCA0c5s2CzDc5PNHme/Y1Gzbq1UocmG/+1IK1IapP7d0qZ1/2iyNser7bpqHH4T50Rma3fPBJaaJajrqCcg2sbgoERfSqnvat/ngzTldaewFfoP5z1UeI7yHQ1xGgqKFXEnnjFFHaD73nCac+xji0op9h5mdF7pQlHohu2ie1se59PVomObPRa7WPkabNm3aLJu2QK3NSjDYwjYZrrwHoytJvY7vQIv7L9bF6IPEWJ2/t5onAyuTDCDsHDdyP4KVWZUzRONVJDW+yqXvrLe5fGgkVGjG2AqlYQz4Cs1FarXyPbKMc43QmrvWakx4Djf5/Enq5+kQobNXPR4jvLbRxSXpA0NNbNXKqtTFkCZcXf9lwjrxBFeeA2U9kXQr34eXaz9itMFnAy3s38o2VyOtlOsxFhaoLVaYPMbsatl61CZNH2XpbdtiXBWHl3iONoRhCgOiSNWBCiT5SZN0xMbQ6okdH9qKJ02kllg+CFy6O0wCNM+8/DZHT/Gp+zZ3UQ780AFIaWytMaphS6SWWF4SITSB8jCqoTiVnHXWcRyPru4etEzymc9/4dVi2XnVtqLDI3/0J2tffvPEjrUxdly3jn+3cWOXzE5kyefLAGQyKUCTnYSeHohadqj+QiCZqweRaCFDURYSoUU1ZGgontKBj+85+L5TDdMXitNAoZSDaUIkFuWNfWOYtvyXhpkgWyiTzCSwTfui/DzvEiYgEKFAza8KVbSoCVGqwhUh8KQJqKqrm8uffvO57bfdzR/de2/3Df39NoGXRcoA24iQtGMoZeC4ipmZAM9zOfhWjkCF4T8DBb4X6mSEBkOCZcDJAFx3hiCYoacb4glBRyZNNGWQ6nJQsRm279jK0eOHOXO6xJr+GIWCQ38yiR0FhUvndQH9N1oURrP0y36ECvNI1kKwLlCyZjNFrYpIRWqFpVyUVDimicbEDASOjDLuC97MzSA3dEM6Cr4DgQuOF2aSG2CYBoHU543NfN+j4PqUpMTZlCGvNfvOnmNz4RQfp4+PXLcVXfI5rV1ecM7ybOUUh1MSf9NaymaCc8USsiMDTglhKCLJBJXxQihasqpKxarDkpY+riHxMmsZK4Nnx1C2CfgowNCghMQ1QEiNocBQs+VrnlNfS3m7FMcoBdINRadBFNeocMQ8R8f1Nuu3Rig446R7w/CXjuOhtMW5M1OgYcvWjUjLxTAiTE+VGD8zydQU5GfCCJaBH77LeY6DcPpUBd8Py7AdLbBug0EmnSLTlcTzJa5XIpNOYdk2hVIJgjIP338tN20sbHvumXN7nt4z+ksPP7z7gCgJ0skE8ZKDj4fSAiWiBEISCIlGEmhJoWCgSCHsJLffc/f0q88+/3OHjkw923PDOmIRgRMUcdwiqCgRy2btunV0dvYxduQka9b0Ik0Tx3Mx7ej56wiCAIXENAkrIYQCPSnPu6kp1AWatbAQaiUwpIURFcQTcX74XOnFn+4b+4P+fnYXi6TjcRTgKcGM1pG8bfQc3bf/+KHu7sjrj3zyZ05bloFtGmR9D8OSJKOSwswUtowiLBu0iUKiMAmnhytIrRD4gI+sidN0uK324hwb41OvvPrC/vvuvZmo6EaoOGgbQ0ki2uLunbt47c2//feWMh7SQuJhIbUi0CbnRWqrRbO2p+X9Fx8Gd0mIOj9f3exicREQluq2fTUwRrhYr9a3f5SwP/1+j38fpb7L3VdZmQUsbd5/5t63YZrXxbnzlc3m6BY7Hq0x0EI6BpZ4bGi7p11pPEH4nTK3THyW2XmJsfc/SS2TIZyvbPX7MA18i1CUd6nK3xhhm15r779e/dvoBdsNsXAo4LnUImFcSnbR/NlGo7n/Nm3atGnThLZArc1iqOe0sJPmK7EaDT5Gl5GmK4W9LLzioWY5P9Jg32Hqd9rGlpGmK500zUMFPs7SB7YLMUpz9yMIBz8DzIbQapXaqrN6kzdzydF+ANtmPvUmGlsRBw+sYDqeoLWJm68TDviGWdwk6QBhm9nKQH01wkUMtnDu4QafjdFczDHM1esMVXPXe5SVbb/nspOw/NVEaiNcGX2RevXkMWYdquoxvITjXmqGaSwibGWl9tXKwDK2ObqE8w0T1tlG7X6aUOT/FRZ/33bRmnMahO3r6CKP32YOSigsFIaSWIEknUnyl3/6dzf9k19d80AyYeL5gJIIFIZW5LJTZIseo8+d+Fe//r/9o/0v/eRFED6WrgACtAPCr4aArBe2bFawlUykmJiYxowkcIIAX0dwKpIvfumfnja8/OlUcOypp779zDu9ff6e7du3Yxom09lpOjO9TE/nCPz32HLdJoTw0EqEdk5aAkYY4hKJ0BIpTJQAITRa1MKxaTzPI6iJ03SARiMEKOUhtCYSS1Ioubz9Vn562803PllxArwAEpbJ+LnTVfHVAsIGbVQFCP75axaaajjQ6l+0TaFgEo+aRMwK3/nmc3ds3sRPfu5zN5kV9zgzuUl6+ySBUmhPUCwITNnBxHiWoycKjI+DbUM8DpkuiMUsOtKJ83lvSRPTihC4AaV8gUrFJTtdITulOXEiS9mHzjWw7pocO+/eybVbjnFkzGFgII3j5SgVCiTsCBiC/MxZBm7v58CBSSamJ+iKxDBdSaA1Wlad5ARhXjMn9Kde+SB9NQRgaT8U5hlVWYrnoiNxTsciHBh36Fi7nngUym4B7VbAdcANsCslTCmxbBvHFpQswLQxzRi+7zMpfCaVT+L6dYiZgB+OFTlweC9rE2lOlHMcTvhMXNPJmUyEgvYhcDAyHViRCN5MBR1AyrYwlYUz46OFix+NoKUIBZA6wBUCN5nm1cOHebs7yc0xG9vzsZQCrZBaYgh9Xm4j9JwAhXo2D5ZDTehWO/a8uyUUljDC8icUFcslF5nk1nu3g3UMvwDJeIJ8ycFxfFRg8fZbRbZtTdGRTHPs+EGeefMMygffBT+A9evC8trRkSERT5x3GQvTISmXXaanJ5jOergevPhyQCadJdOVJZ2GbTdsZmpyAmnm6epKErUMyoUTrOlM8fBH19z6nDz72p6/eOaeX/zFT73sOWXwDQSJMJ+kBEyQoWAVoYgnulBa42nwLZdHPvep5374re/++3Wdnb95w0AvthS4bgXPzSO1pFAQ7Nx5Ez8cPc3E1Aw9vSkqlRKe62OaFobUBIEHyscPrNBB0pAIWXONDEBLDCFRouY6SZjzWiKEQSwWpVDMsuNDN1NSJz70zHMnXtn90GdHKq7GtGzCtkThBzauk+SmWwTaCJAmuLrMeHacDev6mMlNYJhxnEqOaDqKwMbzJRoThERQFesJhcAMm28gwESIsH1yXZsv/uKn3/j2X3/nX27dfO53Nq1PgTQxglh4HbZN4Llcv7Hnwa/98YGbHv3iLW8KaaI1qCWHu1wOy2lv3ieRGrTFaVW01gghruboEavBKLPzDrU51OH38fy1PvxCHKU9lruSyTIrgBxa5L7N5gqXMh6F1V28thj3tNFVTEebxTFUfZ87/7qTcO5sOYvnVpNW5z6+Snh9c+vT71X3f5xLM883TDiXXUv7nurve+d83kz0dZRLH1UkQ3OBXI62A2ibNm3aLIu2QK3NYhhr8FntwehC2wzSuPPR6LhLYah6TuLx+Aofeh57S6VSqx2RsQafNQp7VOtULuW4S2F07i9z869mN1ydNJr3twXD46ycW0uzB+6jdbapCV/qMbrE9AxVz9dsQL2b0CXpK4Sd2rEG22aYDT3QqmvQULlcvlxFBW0uDY3qyiD1y3yG+mKopUwMZQnrybda2PbL1W0fp7mb1UB122aD2Ro5VmdQ22w1WivOhsM0FqjtjsfjDYXfpVKpySlaYrTeB7FYrOGOddr9eoxwweC+XC7X23YMeDwajT5O2C4+yuqtjE9Xj/0YYVmvCdbGmvUfVij/F0u9hQIQ5u8gC9ehIRqHBbjUq9brOcNtIrwnQ3X2e4LGIsbRZaWqwfFWuX85UiqVRlrctl6buYmwzRyr8/kA9ctSvX0aMUZ4P1ppn383FosNEbaDI022HaC1Ffk1csDjDdqXNs0QsGvX9UR1lqRfIeZXULkpHnmI37511yZK5RyIGGv6NlE8M40UBvm85vs/evWdwU888jvvnCyw/70jgMLTFgqNQCHPi5LkfPFWVRgWipfmbAOhmEzM30fg8+E7t3PzvVu//cLzh/+TGTnwazffdAM93SnOnJtm//4D3LxjAGE4CCN08jKlRAsDkEjLRGIiTQstBUKCRoch8pSP8l2071bjbgZIASoA3/MR0seKRJjJljh46DiWRfL119/6V+uuveVfWB2dHDs2RiIaQ2tVu6wwzWLO9SqIaRM153M9R7DlEaMvvR1UmW/8v/9xzacfsX/08OBGk8q7lAsOG9dDyVeUS6B9TTEX8O6hExRLkMzA9u2w7poOfD8gCFw834MgixBhdEnTtDENG8MAbZQx3IA118QxjCjFQoWzkyWOnITsWzB25O+4fss1vBccZ3oiR2faxM0V6e2MkXfKICRBr0tyd5yDTx/i+vwNdIk0vnbDCxWhEE8Kdd6tTgmJoWRVMDcfNUcYBfMdwVpFarDC6LQYQmIAEbeMjtmMTk8wvXENMzMzGJ6JZRm4pkUq04GRL2EdO4uazNPV2YPOJJnqipLXPtL1MQDPEChMtA9nCchlQAuPzqSLZ8Qo2QZlU+Joo2pVZxLgUcoXkJZFp91DPFdm/bhLvljCzfRyVoGLDu3R8Ag0FKVForOL56dOs65zDZ0FD8NTCGVhaokOQnHYXHFatZYsD6HQolYLJZYO8xOh5t0b2wdsyTQFjhUPcccnt9C1TqI9h74ucB3F1FQZ7YNlBGQ6IGKZ7PmL/RRLoSCtrx/61qQxTRAywA9cAr9IoGfQQiANA1BoJbFjMdYlo2zc6mOaknI5wvETJY6+B5OTcOLoEbZv7yMSd1C+SyTqYaRcnJlpdFTwyc/0WTJx7sf/7g+/O/DPv/yLZw8cy4duYaImovTRQqGEAqGQRpi/jhHK8949rjB7E//r915+56Zz2eLHH7jjWmw9AVKTzR8nlTboXLuezu5eDh0+Rkd6W5iDQmAQNiASjVYeCoHSBlLYIExC4ZaJlhLfACFMsKLglKtiNTAsG8fzsOwogVfmxoGOZHHGev2//tdvb/zZLzx4vJArELiwtruT8XNnePblNwiwZ68Pdb6dlXr2Zzg1G3ZzbunRofh43n5KhuJIJelbv4FidoL7Pnzn7/7wBy9+4fM/37e1J23jFnyEEcO3k5TKU9x203re2jHx27tu3PCLFZkkP1Om7HdWC9KccjfHYXL+7wuX6Av/eqH8TF70yfw96svVZPX/5kGKG6Xnok9EM4HceYlp9f/5vzej/vnr7d+4pSgWiy2dd7Wo9q9HCftzjebFxub83GzbSxnu7HJglPn96Noi34vGEM3G/0ug5gBU7/7ME1Csdv/9Sh8fXKL5h2aMEpavVuax59bFZgu/R5eepKYsOH5uofy3Ol9/RQpWPuD1Y6j6/TK3LawtnvsqMByLxZb1fKXV9vPCUJ4XUBNBtjKn8mR12xEujkDxGOHc4BAt1qUVbP9rzwNqaao56T9BOLfbTHSXq243734st3wu8voyhGlultZhqum80utPmzZt2lwq2gK1NothtMFnmwgfcD5e3W6M1sUEjY67FDaxeq4rS2W0wWe1ztow1QfjhHn3KOHKh0as9GRL3QFiTYywSFHCSjDa4LM08BqhhfGFeTdM48HjUh/Ij1WP3eze1Pjd6msfs2kcI0znAKGQrpFwYCGepD3R1uZiGpXpEeqvJhymfpu51Hqyh3DlYCtlO03oZvX16j41wW6WsH7UBJyLDRP9OKsjgG6UjladDcdoHgq1JpZaTRYTPmU5jC5xvz3VV02s9jirFy58E2G7/nuE5fAJLr/VlI3qY20VaK0fVqs/j9Nc3DO6AmlbDqPUv6+PMXsdo9W/DRLWs0bl95kVSdl8Lsf60mjbEeqLjxsJbZfa7g/Telu9iVkXw1EubvcHmL/ytlUumsxss3ikVkhcTOUS0SW++VdPdz/40cwXrtnQw1RukngiQW56Cs8rkYylefvwKQ6/y+fX3WjS3ZUmEBK0hyAU9ijmhnwMw9rN47xgrSZCqyLCkHfyAsctpyJIWF3cP7jt1/e98vbH+nunbzCFycsvvsutt11HLKFD4YtpIJFoKREYSAwEBoZpIE0zdE6rCTECn8B3CDwHoVQYglEotPYItIvWClPEkYHJW6+/yfgUDO6+3Xpl/9Hffuml1/7LzXfefdqO2SjlLyC+mr1eqQFNGL6zdvnntw8dx9xyhXg8IJ3kW/fdeV00Ik+Tzzus6YZyEZwALDPO2ckSL73g0pWBHTt66OqDXH6CfGEGKcE0BdGYhWkYoDQqqGW3RkQFUcvCigmkVJTLWex4lO3rNrDlJo+TJ8Y5cVRx4I3jTEzA/gNl7r+vD6EDZnIlOtJxrLhmYvwsfXdu5sjYad55/Rib5AAZFcFSoRNTLZSnRBEIquECQ1e1pQjQmqHErMDDUKEgzlMOJdvgwHSBqXQfnikQvocKQgFQPneOa1JpOnMVbu/fxNrOPg6dOcXBySmCvi4mAp+SIVASlITS+BmQBgXTgDVJpk0DIWp3VEJQ3VB6GErRa0cRZ3P0lTUDgeTuzDqmOxz+4uQJMgPrmVBOKI5CozXknDJr+3t5feIgOy3FhwyblKOQKrwuU4WHXw2EDkNshtomm7BMhoJDLcD3NW7g4toB4+k8HRsidA0YSDFNxAqIWAZFJ6Aj1YXwI/zgB6fJZaFUnsa24I47LDo7MxgmmFaA55fQysewTOyohRCSAFV9eBe6V+nAROkSFVcTuAGCEmvXR9m0SVLKw/PPlfjpT85x9z1pZgyfmOuEgkyhiERBiSkeemRj9CevH/tLkfDv9QyF1tWyKaqhLIVfdf0DLcKyGkj/fBnt6O1DWKVPvH7o9Pf7M5GHtm7sIFeYIJqwGZ88zvTMNB/5yO38/Q9HOfDGAXbu2E6lXMEzPKKRqqC9KipUKiDwPXRgIWQErFDEqoUBImyftG+itApdKg0TpUGpUEzX3WmybWsfp7Inny4Vp6+LxvtxlMJ3Nb09a9HiDbTw59zVWQFacGGdW6gO1kTBc9qtmlbMElDyHOxYmmIxz8Q4v/D2obFX7rilg3IpR7o7jmOZSG0S1Zqbr+cL3/zGd37tk//g01MxK0JnT/+Sy2abq4M5i2GHqL/YbR/zFzg0WiBx4bZXI3uYL6xJ03gB0EpRe8Bfb56pPaf5wWAPs3MNjcSiOS6ut/XG1suJFtLKOHYp5a7VRZNf4eqOdHM5M1R9v/A+fpnZZ0gj719y5lGb8x6mteeZTzJ7PXuZXZA+t/5tIhTgPVk97tjyk9kye5n/PZ6mNdFdjvlua5eCDGH71Gwe6hnaoXzbtGnTZtlcCo/1Nlcue2nsplMTGRwhXPt4hOYdkH1cHZ33McJrrUea8KH43LxrJoA6yqV3PXk/yBKKBRqxUN41EqflWN5kyBOEnfzFsJOwPnydcJDw9ervixWn7eMKXZHVZtXJUr+dqYmId835W4ZwAN4opOxy6slQg/TU47OE9eJbhPXk96q/L1ak8CSrM7kw3OTzBVcjN9g21+DzTbTreo0s4f3cBWwmnPhbatiHVvgsl2e4kT00LzPfAqYJvw9fo/lE6mK/y1aDZu3MTsL2oCrt4Gmai8VGlp+sK4JGffPdhBOVA3P+NlD9W6O+x+gy0vMojcvohaRZuN3/Motv93+DSy+2vOIRGqQO3XJCAYdPLM6XNm/eTDabw3M1loxSqRSxY4J3jx3m4Dsn/vjTn3nw1XjUJpc9HYbFbLw6fMkYgUladoHTQaD6sBPxz+w/PJl//e332LopxfquBJYhQxFa1YnJFCamlEgpsQwDwxAYVZsuoRVa+fieQ+CVCZSP0gE1YY4WBQwjTyppMTMp+MmPDpGfgY8O7qQr04FhGpTL9IqqW5LnuufzsR5KzAqpauK98wI+USHTOcOff/O/fHLwgciHMaZx/BmsCJi2gVOBwI9z9pTDT34MmzfD7gfXku5xqDgF4rEEqUQXqUQvttGHDLrxnU7KxSTT04Lxcz5nzjlMTHpki5KyFyGS7EHbKSq+pFDMEvhn6e9V3Hl7gp27oqxbD+dycPjkJL6VYSawCITENh3sqEdZneTmR7ZysivHu/IoSios30aoOErHCXScABtDgbGK4T0BNBJXmgSYGFUxXDEW52A+x5SpyBo+E0aBAi7K0ZhlC0qC+ITD9mzA50SKR6Yr/BOjg193Orjv4CT9Z6eJ5itYlQCzrKDkQ2AQtRKk7SSxwCDqS2xXYLoaKgJZUpgzHp2TRdYePMWDp8v8s3yU/1328NkyPBSL0Zs9gz19goRfwQp8rKAqqvM1TszmvYTk1UoeV0SxfBNznqxxNTIvrPdRTxLxTaSK4hNHIavOapIgYuD3xHmLk/zUOk7/Z9fQu9HE1gUidoA0AxynjA4inD7lMDkB12yCnbdHuWt3hmuu68RIFgmsLAVvCke7OEiKjsHkjODshODsmRjnzsY5d85mctImX4zg+3EMEyw7TGcQuJScEgWnxEcG+8l0wt99L8fxMYdCsQPfiyONGNFohGLRR4gSn/l0+p4/+7M/+4Q0C2BNgJkFs4C2XLSlwqW7Bijpnne9qtVjPwhIJJPY8cjHnn5x7I/eOD6BjqdJdPYREOB7M2SnDnHzh66hnPd56fl9WLbGsDyQJZAuQpmg7VCkqgJ0EDo2Kt9DKw8ZaEw0UloIwzofjliLMCQohgVAsTjFurWd3Lpjw5ZXn3/1T4RTIh2PU8q7TI7PLBxeeA5CqxZfnH/VUMIn1mFSoQRmhEd+5t5Xn//pzB+fOjWDGVUEMg/CJx6JYloxrt92I4bmS3Fp4Dsup0+fC4/DHH8vwYqGt1Tn/9XOM/9f8/3n7rf4/Zeb3pU44uyRFjqiuuB12bIH+NICf18o7Ncw8Dnm94dzhK44g7QXLmS5eKz1GGGffbVo5j7TntP84LCH2bqXJpy7v3AsWBOdzK2Le4CPcvF84ZOEcz5jS0xPloXbjhpfWsKxd9Ha3ELNkb/N5csQYRm4sIzWFs+NVbfJvE/p2UVYZsaq51+sOK3GXsJ5noXm3x8jfE42wspFOmpGpvpazJzt5SJOG6X5HOpqRWtp06ZNm6uOtoNam8UyTNhpWimups77E6xs3g2v4LEud55g8UKuZsdbLo8Tdu5Xy81nIfbRnmRr05hG7cxOQsFKjrAMNRv8LlfImWW+tff7xUID9pVgiMZ5lmNxbUuW5iHxhgknEtp1fpYxwnwZZta2/lHe3zJ2qagJ9RqJShfLyAoea6mM0jzMx2JYbtt1pTFC/XZkN+GEZG1ysFm7f5Tl5d0YYb18bRnHWApPcnWNKVYVoSWCMLwdwmfLdfKXO9JxtBL0dvXilcrYpkU8FeHQe0e8oyf41ZtuM1BeGdu2EDpYxdRJnEJAKt5Bycmx6bodh0a//8J37709/oVdN38IdBnPEyghENI47/wsMTAMGykNhA4fzEsUWgco3yXwy2jlI3SAFArwUcpBo0ELDr79LudOAoHBg4P34EmXqakpvIozHY/wDoBhGqCsZV2bFC5SjLO2n8d3fKifWKJCMRuwfl2UqZkK2rDI5wQvvRBw/fVw3dZO3GCCAA/DSGBH0ujAYGKyzMS5PNNZh0I+OFoo8242x7FSiZI08SIRPxaLsSESZff1N5qJnt4OUkkLx5/GBkwNmiKmAXfc3cVbh6Z4ZV9AptulO5VhOj9JVAZ0Jk0qCMZOHmHDfXEmns9yduIcUvVjKBsjMAlk7epUNXRgnavXc4R6y8hDhY1EYSqoWJKZ7hQvvncIf2M3Wb+CI3wQGiFiyMAkk+xFHjnOdhVj82QZ6ZZwtCbRmSHS38vB3BjjhkB7Ppg20c5eLNvGNAxEWIrQWmMIgQ4EgRO6VwntYzg+A5kMd/Wmub1o0TtdoJg9ycbr1zGY7uG75ybw4hZlK4pQJloZGJbgbKVIur+bvadm+GS8H1eCTYAhFEoKhBCrJgKt4UsIpArD3AoIhKRo+0xEz6IGDDrWwRn3PfqNLqLSwbIFM2WN50rKTpFXX51h02YYfHAHU/kTyIhiIn+uKrwyQWdARznw5hlyWbc4fo4f5bIcj0Yoo7EQxIGNfd1sSXeyqXctZDqhI5XCMARKFOjo0FS8LLd/eC2Z7tM886zP7gfK9HbGsFIB0YhBLOpQLmbp78vQ18PjY6f5HppZUVRNzzXH5VGJ2fJYLpeJ2DEqnk88meam26557OlnXnl144lTT9x793YSsTTKL6MpYxo2d9+xncPvHuOZZw6waSDG9Vu3VY9fK/8+QmkMQ4CQKOWCJ8KZWRHBEAJhGAgiBIFG44OWGFKiMbCiMZT22LS2l913mF/44fdHn3vggYf+cyzSsSquhHPRAspBCTNuUC65zOTzFMr8Ly+8vP8LP/ezDxtldwohY5i2TTmAjnQnWzZa/6hSzP3fyeRapqfnH0+xmiumFw7xufhjLDeFkqULwZab9iueEWb7lVR/3sPC4+I9hOOJ2sP30VVM15XIMBePl0dYHTHALhrP/9Qe7LfJgMnbAAAgAElEQVTnNz44jDA7Ft1FWK5qAsja/MVC93t0zvYw66a9EukZrb7vJhzfjrI0F6lm5XkuQ7TL9ZXACGFZG+Hi5zlzXd5r3yv1vneWQoawvA8S1pHFRH/KMRvScyFqTvTDLDw39Fj1VYvus4eVbf9rdXmQxT+/e4ZL74RfE6K28oxviKvDbKVNmzZtVp22QK3NYhlh5UJsPcPl8WD0/WKEsBOzEg9grzar+lFW7uH1UVZG3Jdl1kb5/RCptcVpbVphhOa24Glam2BZjBtYPerZja8WqyVOq9l8N2Ip+TVMY+FburpNe4XxwoxWXzVL/EdZWTHz5cgwYZlZifr0VS6fBzjDhO5ZK8EQV9d35ROEbUSjMtHq5OfwslMTtvtfYmUXZTRitdr9qxMN5ZKHIT2k5fOtPU9/6JGPrN0Wi0XQUmCKCMKoYEnJG28e4tDRwvDP/oOPFQNi+EEFqf3QlWwVhRK2bZMv5Il12fy3/++F2z798d6Hr79hA47jEPglhC0wpIGUJmgDqoI7U0jQPioIcMqFagjPAK09pKmIRAwsQ5KbmaRSKqJ1QCbTw/GxaV56vsAjj+xg247tjB97h0q5gusqprPZZ++7795SxTDxKYfObUiECMNHKjE3hOecbBacd2lCm7WsR4oy//1P/jp16618JJMC15kmlQEsi2KlgsJi774iqTTcdvv1nJt8D+37OA7EIyYnTmR570iJyQlm3n6D3z43zg/+4S/f91ayUmHztYKKV6SrpwcwmZry+M53ftzz4+dyj9zwodyvXHt9fPfOmzrpokgsppjJ+8TiNhVV4dbbBjg9McaBNye4584evHJALAKG6MSUUd44fJyf+eRatlzXzUtfP4ZvCq7NdxP3EuQtA0/aeNLH0GBpMPTFLnNaLE2kNvc4gRZoYSEERKMGTmeCfUGJt6IGxWSCsu8gDI0WYbb7SOxChX7P4t6N15LKZlGmRSEuORRzeKGSJRcFzxIEwghDhkrwAhdRTaiUBgjQWhFoQU38FBiabETzHkUi2RwiSHBHOkWnzkDW4y6zk/cKWUbLRfykDYEZhngMwBEwFY8zkTHYO12gJ5ak13eIqFnXo5r4ckkItaDTlgI8QxFIF0eGQru4VPiuomQITqssh2Nj3PGxG7k2meYnzx/hlk1ZrDi4XoSZQgU72sdLL58i2Ql33LuZmUIZy0rhiRxKWkTsXqanBfv3TfL6q9nRmTxfC3z+7pf+4QMTfuAyfm6a3t5eJs+NY1tJ4lYX/8/vf++m667nwbXr+Nfr1uU6Nm9Jh6FCDQefPJ0Zh803dnL87DQHD3lcMzhAxT9JJKaxLRPXD0hGXDb085Gxk6S0Ii8I75Oo3q9amxW+h+F2JRCN2Wg/QGtQWlB2TQY/dv9Xv/OtH3//5IkDv3f3HZ0Pb97UhR03KeZz9PR2c+eaWzj49hH27TtOzJ6mq7uDqO1hSoXrOdhWBMMUaCEJEASeDt3KDFBYGIZR9Vc08QMfravhTpH4vkQoTVQHbNvYT3lH5T89+Yc/eOFLv/Lwy9KIIqQO258L7221foXlZla8dHFI4hr6fBlR5/NGUwkcLKlQJsQ70ux+6K7CT5974d8cOvrO72zY0I1SBo6jUdJCmhG6OlLb/vxPn97+2K/98gG9GMFVvXS1XOxXQli2BBZM95xjiVaFY5co/Zcfo7Q+VskuYturjTEuXhiXJsyvQVZOpPA4jSOBXA4OOW1Wnrlj0VoUgKFF7D+68kmaJ25dKosRp11O8yptmlOLLjLMwmKuNLOCrq8TPo/ZS1iuakLKMeqLlHYRzlEOVF+7qq9NS+y/f5uwXtU731yGCcVnIyz8rGonsxF+coTXM0p4TbW2ebTOsQeYdecfJLzGXSzvWd1vcOkXGg4xPxR2I77E1bUYtk2bNm1WlbZArU1D6qzMHaLaSV/GxGgOGGq28ndZE6/vA0tYvTxE2OFbzoPl81ayV1n+PUrYGV9u3p23sm92/hbyd1VFanPO3xanrQJa62XVkffDvaARDc49BDy9zPq/T2vdcJBYu/56+TDn/O+XSG2eSGGF700z8cdFdv6LaJ+HaSzk+DKztu/z9r+U5W+1WeS11VbmjhBOmDwqhHicxa1IXBSrnf8Njp0FhoQQ31rm8ffRQIy02v2HBa5vlHBi98vLPP+TwJ4rvX/UjAu+v7KE97JZaPhmtLxwpIX8HWG2Xq54uz/n/F/h6nIUfl+wjQhreteh83lSHXy+uyddFT3YOOUK5dwE0XiCY8fP5o8c49/eJSVohWWE76uLouTn6epJ8uOf/E3iwY9kntpx07VdqYTAqVQQ2kIaAiFBShm6NSljts0OFDpQYahJrRBSYZiSQIeitZKqYJsGkXSaiJ1g72tvc2D/FPfdu5Xrtqzl6DuvEI8kME2TQmGKiqufUlXBQaB16DaFCoVWcmGBwIXivZpwBMJ3S7PN0EQEPqCIRqPkZkqkOjvZt38aTNh5SzeFyhSRmEkiGSURF7z2ao7Tp2Ht2gRnzxadT3zqjv+I7kLIDpIpSa50FmklmZ5JYYgE0XiCR35m7YQZ8b/R0SW+MfLH39y97/XSb31kBw9/+NZefJXDNmwCr4wKCjywu58XnjvD/tcmuPVDvUyMj7OlN8OR198hkQQrVsBeK9n+6DW8/ZdHSbqKPi0RInHeNSsQPtYqCicMBMo3EKYAU3LWLfPczBmy63px4jHIlzFsG19IEAFSVejMVdiW6MKMxsh1Bkwn4Jmzh/lpdpozXSkmknFcIxSiGfO+O2pCIIXW4LkeILGjcYRl4po2UluMV1xkEFDMTvLuzDT3dazlmngH66TihkqRV0ozTFZclJmsihUVWmkcYZOz4MWZST68bYDUmXFEsQLLMembSz2RmgAlFFqG5VpJCzfiM2VOc9w6ytaPdZHe4iPzPl0JePutMrfe1sPE9AyxWC8vvXSKbA5+/gubCfAR2ExnXdLJbkrlOH//41McOshT587wf37hF37+Ge0nqHg+Fd/A8UtE093MlD0qogsp05zOCn7hlz77Zjrjv/nG/qf+hR2xePmFHNffANdt6ceQecYnprAsg/sH1/DX3znLybMTXLM2vDeWYWEJgS8DTEnUgG2B4KXzArVaiMl59XJh5yyhJQQWbsXmgY/e82Ysqh959tmffvHIiemvXH9D/NoN69YQoMlnp9i4cSOBLzl8eIzrgvVsHujDVx6mBFMoRBCAUXXDQ6P8CkqDlAKNgUHopKa1xPPDCOeGtkLBq9bYCpRyuXX7AMVS8e+effapjR955DNFhA/YdW56KMqtIfXFeippUC0XocMbgEF1u5pIU/sYtsbTAcqDMxP867feffc3O/tiyWjEJPAFGBG0llx/3QDvHp36/MTExO+kMlsbFsk2bdqsKsOEc6Fz5y3ThK7HNSfipQrHHq0ev9GcaE5rPbiMc7S5xDSZnxgWQtTGoo8R3udLLTpZDkO0vthqpRbBt3n/GWZ2HrGRyKom6nq/eYYwjaOL3K8mwHu8un+9+Zg04XWvVCSDpfA4syK595sBFhex6UmuLrOQNm3atFl1PjDLqtqsDkqphV57lVJDSi35AURt1dQYhIMcrfWC57oSWORDzjHCa78w3n2rXLTi7CrKv5oYbKl5B7Md35bOX6f8X5i/tXQ9uYx0NTr/V5VSu5RS2Svx/l7uLFdgcilFDg3K5qhS6ivLOHQOGFqozF1Y/mr510L7Uxsg71tGuhql90tcsEqzxfrbChmaO5gNc4GAdBHnH2E2/F49Fpzcu5JFNkKIhumvfbc1ey2Qt2NKqScIJxtuIWybl/O90fAaVosm5WcPYZlfKvuAQa119lL1H+pc1+NKqSeXcf5nqLYDK1j/L1su+P56guX1Q+YJ+JvRYv7uIewfNWvflkJOa/05rfXwB/X+Xko6OjLks1lK5RkSCT7d09MFQCyWZHoqSzJhcvTIuxw7Nv1vf+7z9waBVCjpAiC1PC+2UmIlQjbOJzB8PLvM6elDCLzvf/i2DV3dCQfcEp6wCKwECANpSITQWJZFzI5gSgPlB/hOBeW7VXeiMKSnClwCr0LgOQSuT8VzcVx49rnXOXF8ik9/5h5uuH49U5PHMKSP1j6mZTI5PU2hwE+VUKGgR6jz16yrjlpKKy78B6H8ZdYLK9y/5qwjA1JGAFJFQdlIIw5GBDuS4MQZ6FsPmb4IRXcC0xZkJxUvvZjn7Djcdc9abrljGz39ZuIHP3gpleiIE40ncJSPlYxQ8gTRyBaQ65gslJEJgY64TJVyfPJzg8/cc//dj/z1D/ifnvzv45Mua4kk+xFC4DlTbOiyuH4DnH4XZsYNOjIdZKemOXlSs6kPko5HTJTp2qrY9rPXsD99nHc7JnGES0QZGMpE6gXWR8659uUitcT2TczAREnBwdwZXi5NcSYVYcopgxUlIArCBOmS8Ev0HD/DHWuu4WjM5Gu5k/zmsb38WW+UN2/YyOFMkumojWOEYie5wAvl4bsOBB74HrYRli0tFGXD4GwswtuZFD/tzfDd7jj/oZLjf5RLnDET7Lh2J+vKUfqmNUkXjAD+f/bePEqO477z/EREZtbVXX1342gAjZvEQQIUeF8gJZLWTcu2vPY+ryg/y+vxetay5TeeXb8Z07Nv5u141zb9ZtYz6/HYoKW1RUuy7luUQPEmQRIgCJLgAXTj7m70UXdWZkbE/pFZ3Q0QQOMkSCo/fMkqVFdlREb+Io/Ib3x/SjvISOEGLr5w2asiduoaUXsOc6aJVeKt4sdTthFzXLNO0e7SxosyEqyDJsukrPOy+zpDH2ljzdVZOtrLOG6ZvgVw8BCUSp341TwH9x9n7DDcubWbpl9CUGNsYi9uxnDsUJPvfvPoxKOP8avX3/bRez70Cx96pGwiJqMq2stRqrWjWcTYlGXaF+S7F+IriSxmaHohX/jWt4v5AVm45tohrtuS4Y2XYecLxwibLlEAuqlpL+Rp74aR0Sly7Q6eJ/HcLFknT9bNknVBKopSgUoWKeNFyESslrTSyQ5/rbbJixymZMmKLuqVHNffcOsXnn2RNV/9Yf1fP/L0/uMvvjRCJlMgCOssXdbHho3LOHT4MLt2vQKhQ8b1kNYgdIAOA0wU4so4Oa2JAkyoiSKNTs5lUok4PaiwsYBRdyCjIo51cU1E0dOsW9PXjeCHRpaA6Iz732iD1RFWR2gTzbxvLY5QOFLEr0LGQjkhEFIghAPWw+CgVYBWPqEI+PC9a8PhQ/zHaq2BMDbeFiExQtLfXaS73flIGIZMli7J5XhKSsrZcy+nvi/+FLFQzRKLBFqOWFtPscBsKrfWJLqvcmbxxkjy/Z3v9vHrn2Xmuf97gBPH+v6Cd69A7QHOzQn8cqcmTLkwhomPT3cQjye9E9hFPN63lQsTbrXGRf+ESzQmehFYRpxJ4WvMurNdajqJx/B3cm7itPsuUX1SUlJSfmZJBWopZ+QMD4W/Zq3dzLk/dGo5Qe2cZ/3vCmeY83w43XITOte2m7mpb33wM9h+rbY7V5HLCLFQYdu5lH8O7TtNfKH681y8B7G7rLV3WGs/e7ry383ilHcC72ZxGswbn/cTuxGdKzMi2LMRBs19PYvjzzDxYObFvDn+erLObSf/Yb76n8P+u5/53dPOufyTuG+eOnyck1IUXO74u9ScrUBtnvbdSdy2ncTH569frPq9HQ5j82zfNuJtOte+9AhzxGmX6/rhDGXfZ609H4HtXzKnj7zbr4/m4zTbcB/nJ1JrXV+e9cD6ObRvS5x8Puej0/GgtXbIxvci78n9ezmRQNDwyWUz/Pi7PxkcXNhxtespyuVpIu0T6ZCpSp0X9hyIpqv8pZctJr+SgAPGA5sFO9fBJxY1tBZhnBMXK09YTsYIZp2eREQ2F7Jz1yv/5cbr+2/0nDitpyUEJRGOTIQUAikcHCFnBNHWxoIMQxOEDzIA4VMujRP4ZZQMyeY8quUGP31kF1EguOXmW+jubCMIKmBDrA7RWKTyKFdr+AFiRpiGE7uEWUuIxTIr0ptdWhK12W1rLVqAjh2L9spEHGRxKdV8Mvl2ao0QC7R1QtWfIF+UIC3Hx+ocPwrLl8GCgW4a1QYvvxSN3PNzmyrVyjH+4Z+2ZR76yleWKKeE50WMjU6ScbuRsoBy2sjmuggjhVR5ynX46Cdu/4fXh1n/t38/8uj+/T7GtiGtS600zYqlPWzZlOeJx47RCCVV3xBpGBzogKCJX64jvTLdqyXrf345+wv7Gc8dp66qWGlxRCJgFHEaWC3itIUWmbThhQ1PCQyONGhXsd8EvGYiSh1tTGDwa9VYdGRsvGiNMJaVV17JvlqFB3e9wGNWMzo0yB5PMBL6VF1JTQkiKYkUKGtoCwIW1uqsmaqy4ViJDUdKrBstsXLKZ0EtgOlp/Mo0VMpQq6KjgIYyHC96jHTlebFD8RNT5qGRvewsT9HdvxAnNEi/idIaQoMxCmsVDako9xf5yeE3MG1tSDeLFjKJlViQpky8nA1yjixSWoO0ZmZfgMQxElfHIj9pJaEy7I9GeSV4gxVb21h5TRuOM05YHQVZp6fPxQgYG6vjKJdnn7YsHoTFi7rxm1WOjk3ieR1MjsHf/NXhR597mnV33vGBfwzDLNJtJ7IuQeQyWTbIzABNXUQ4ebyMpNE4zI9+8I0lX/3ylzOOKvGBO68qHxppjpSmpli8eCF33LmUw4dg7FiIYzNI4TE+Ps4V6xdRroLfiGJBl3Vm5YQCpOBVJWYFaUIkBmqt93NOIcLOivm0gFBBTftkO9vQjkPnwkU0VZ67P3aDvvvjN/7Hp19kzaM7Jv7D48/ua/rapWkMy1csY83apVRLPk88tpt6xUfiEoaW0A+xUYQwGkcaTBRiTQg6ROsQYyKs1bEbJCBkfO0pROwOGbuvhaxYvpjbb1l04w+//ch/yZo6nq2jqIP0MTJAywhEACLCos9w/taxW6a0CKlnFiU0Dhop9IyAsdU2HR3dIHJMTvKXO557M8JKpHRwlItCkHMdFvX3bP7uN76zuCOfv6D+feqYTklJOQeGmX/S7+3EjtZ/QSwaOHmxxGK2nyTfm8+x/BHie4F5x5dS3tmcxf47eVLn7xKLTjrf9sqeH0PEYqDfPYfffJrUFfC9wnZmhWoXbdzwHPl6Uv4px7jPk5bb/hDxWPylmDw4HyNJ2V2cfrzq48B+ZrNiXApawrRh4hSnZ+v0n4rTUlJSUi4RaYrPlDNyqpvE1kNZIcROY8ymJI3WZ4UQ8z3Avx/YNlfQ0FrXu2m21Nz6w2x7nOMN9Vy73fs48019S/zwADCdtt9M293P/G1XIm63B0gevJ5L+fPEP8aYE/5NfPP9taRe989Tt9OxK6nvtlOVf7Jz1XnG388sQgiklDMD/Se343xcpP5/UTiLMj/L7AzYs4nFrye/GT7d+ufGn1Jq5jN5mjRWp+F+Zmflzpc680x1fYAzzCa7SP1niPkHqO4/2/LPcPzYTjx4eyZr9futtVvfrvi7FAKsk89frXqfqv5a67d8Nve7rfg7B1rH507iY/R9nKNN/9vZ/88yfr4GDAkhHiCeuXumvrTLWvuAMWbbO+H6YZ42u594X93P/DMaT5n24DzO3+94zvL8dR+zx/2zObY+SHwcPqdZ3+cY89NJGQ8wm17onI/71toHjTH3W2uH54vf9JrowshkXMJGjUzEnUO9vUgMuXYPvzFOviPL5BQcmuALxY5C9Zknn8LoWEwlTCzQ2rjxJoyIsE4ZISxatxMFDs2gQSbjsnzZYgSzwg/HcSmVSkhXENkIY0JmXMUAz8sT1APqfoV8RvPcY4995u5bF/zWFWuGqFemsLgIJVBOiHJi0YbRcbpNLUAaA9qAASU12pSpN2uJK5Egk4N8Lke5XuHIyCF27aqxatUAN1x3PdYElCaPIEWAspaMm6XeDJHSUGuYqVyRw6MTowQiT6DivqmFAwJ0Un8r4vOZlSIRdrTi1iTp9WLhjFYGhebmW1YfPrz/9e8cHT/+oQWLM/i6iYoslYZFSOjs7KDQ5qD1BDoMefElWNgPq5Z3U548xvHRLAff4P/2rymz66Wd/2bLDfwL5dH/xutPPXd8lN+vlF9/PNIv0gwE0rUIVUOrKXDGkQJuuHoLd9xz02itNHnbQ//46jd/+ZODHxlYvoDS5AjFdpdNNy9kqvYmTz87TaEdFiyAbMEQGRjo66Dsa7Qqo1YprvxwJ09/4XVWZRczaAfwQg9BAEi0cIiETAQmBojbrSVga/FWJ6vTn7esMAgXqgXJnoLHj8ZK1LsX0Gw0cXAQfoDOGKyWoBQ15fL9sEIhaCAHlhA4ETW/judJQuVgggBrNZHjgsqgaw2WNCKuqAVsiTyuLvSxuKuHg6USOypTPBfV2NffxWFXUDUBGAMmAOWgpMIKSy1veF0axl3Lk7UDNEJD3YVI17FNi7ZtIBwiYUAJOhZ08+axvbx+bIybi53Ua8eIVNworoaciePKCtBzLsdb/WvmDCHMCc5povUbYTBIXCNxjSIbQSNq4jtNjuamONA1waaPbGToakHJf5m+XodAR0wbQUdPO1ZMMH78CK+Nw8q1cMutiyhXx6jUA7p7F3DkQIYvPzTyrTvvuO2juG18++HvEAnQuGjyaNuBMUW0fQUpfLbeuoiXdn7r5oXd/PmdW3if8Rl76SeP/9cr163/d8M7+bPp6+3f5NyQTF6xaDEcHIFFA10I6ZPPZ2jWBbk8VEqarkwbx0fH6errZ6ra4PBRviMkh2fCa87p00n+PTp6HIPAJG0sdSyCUgakFQxPjiFt7A42049lBFiyXWKqb8nVf/S9x3f+1x8/Of7nH75ryS9uWOWwfs1aVi9cwu6du3n6sTdZvmqAgYE+cm0FgqhJpVGm2NmBjvw4jax0wAqstkgJSlji/wKko8FYIgzg0gx9RKXC0EAPd74v/K3nnx9/YcOWob8uSY0qFqlGsThP2QhlJDseew5hZgPlhO4lDKrV4URzTpdLrjesZtfTj2JthCAW1hkrkNaQ9ajs38cXjm+q3zfQl8HzPKwOUNowUGxHNUbv9CfGPo892THxHCVmJx8PxMlrmN0v57X+C/39vJeUp67txeNCt//y0mg0LncV3tMUCgWYnfS7nfMbhzlbSsTjFw+c7fh1ev3+zuYs9s92YhHKH8/57OPMThrcfiHl5y+ByHkO9xI/dzltnzjF9n+aOSKi9Pj1zqZer5/x77lcrvV2e7IMMTtuuOwSjhntIo6jr5GMxZ+K+eo/H/l8viVUu5843u/j7N3DzocSs2OwX5vz+X3J66dO87tPJcuDxO2yHS64/1/I9n4a2Hah7Z+SkpKScmpSgdq7k/ksZy+atfCpbhyllHMfyk4D9wsh7udEy++5ddnOaWaUtC7w300Cq7nMfcB+Hsy9ONzKW9sO4ou4087G+Rlvv/uTZROnTku1nXlugOcr/yzif2Y9J7EtWVp125q8P9XNbol4H7cu2ofPVP7cck/370vENO8cu+uLwtxBsvPhAuP3gjnLft+Kq3uTZYhZEdQIcbxtJ47X4bNZf2uboyhCSnlaIdE8nHxzvJW4j5xOoDXCif1k3vPcReo/989TTGsw4azKn+f4cT/xTOTTcTvxTfW21u/ey4O4p9u2i3Dem2ZWuDxELJy5l3MUFF/q9j+H+Gk5eEK8HZtO+tkpr8Mu9/XDWZS7k3h7Opk9ds1lmHi7hs92/Wd5/n5XMM/5a1uy3Ed8bB3ircf9t1xznAvnGTfDzDoazj3un04ouos4DrZz0nH/csfve51ao0SfA2GDG3o7O5C2laozdgp7ad8RRiv8P3ldo9juYhMHNatiVx+DnHFkshYK+Q6O18p4jsQVhi9u+/sVy5f1/Yf2Qtuycrn8cKlU+tu77rpznysyNKMmhijWICTlZoSkXD9OZ7Gd73z9kZuu3aj+etlgTyLakFihUI7CcRVSCDAWYxIBiY3QRmONwCKAiK6eNsbGyoRRSLFYJJvNcuDAAfYNTzBdgnvuvpaFCwYZP34UVzEj5pFWYnAQbo5nd77E6/u5d/ONy44er9nE5S0eWokQWGFQSRedSXOauKfJJH2gnfN3SyymwzpUKpq9e/lN3Im9H/3YooKTK9KoO0xP1JAWGrU6rivQFkygcRWsWDFIvq2DI/sO8a3vHN7xcx9e8LdPP7vvw1ducP/dXfdswJgy5anGdbt3Tz72p392dNNNt3i7IrKEviCTFUjBjPCj1mhinSz5wgC339Hz0Ye++Pizn/xk/5aVQwNUawcpFDQbN+V58/WIR58M2LA5jo34mGRozxhqQYXAk/SsK3LT/7SY3d88TLZuMc0iXTKPMpJIJs5dhjj1p5UXnOrTCGgqQymneGTiEOO9XdSVB0biYsEmAnhrwTqECMbzDtOeh6sdEBKjfECisCjhoKwk2zQ4jTIdUxVuLfZyS2cf12qH/FiJwmSDfsdlcVsvV3cM8vWj++l2Q44pTbXgUnIgdCKE8rBSEUlDkIV6xondqBIhiTBJ7AJx8FgiYSlLS7aYZVd1gqVdLlkhcQxE56E7MSL2Emu5XxkrEUgUDtI4WCOp1mt4/RnquRJTmXGu+tAyutaEBOY4eTfEtQZtLa4SRMbguPD8C7D5Krjj9i6q1TJh6NPX28XBg3W+++1jO+58/10fbfp5CoV2lI01PJIQaSOkjQiFj0WiRJUvffH5q/+Hj+cf+9BdqxjocJgYrSwsqH1/8syOPTvuev/6//7E03v+xR13L33f0FA3CxcfpzZdRxoPx4YoI/Ecl1oZJiYb9HX0kysu4vhUxKNPTdd27eQz7b1x854caTNnVCtOKTLSEjQW5KwLHcxJl4pAWA+b72DzrbcdbJQP/dKuvUc+MTVe/lddOXn9FcuWsuHq6+lZMM6zz+/keKnM0iULWbxkASoQHD0yTFdPLzqqgJNDKgmoOK2rlVhjQCy7zMoAACAASURBVMTOZkho3X4J5aC1Iesorly+iKBU/X/37dn14vJrr36qqoPEKo5YLCkk1mrsqXLBChNn2036MULHsWllXK6xaCxWgkbGgmThxl6RyeoU/l8dPjJ1X39PLzIR1zkS+nq7cQ03yKj5+TMJTFNSUt42LrVI7YSJjy3S6/d3N2e53+4nvs+be3+3jHic6y+Tv7+T0mEOEd83n2mi6Kk4QZyW8p5kmNkx6yFmxy+2cmHHzRFmn1dt5zzHYy6QuZN3t85ZzmkC7yl4hBO37XTcR3wcONNk8JZQrSV028ns2NCZ6GQ2DfVWzr1vtygl9fzaPN9LSUlJSbkAUoHau5Otb1dBp7oBaT0Um+vikLCd85gRcx6W3u+op4kX6SH1ds5zNtE5tN923mFtBxel/VoXqRe9/HOM/4tet/kGAN5mcUprEOs9xSke8m/jzH3xhMGUyykSOseBvZNnLV3w+ltuUudRl5M557qdDRep/9zHeVp5n8fxYzvneIyeJ/7uZ36B3WVDSnmCG9nJzLd/LtLA9jCzTn4tEefpZvK9hUvZ/8/z/HNOfekCUqrcMc/f5z3vncP+m+Y8Bn/fjv53uTkLkfU2LtHA+QX2v9Y+3XYhK0lTAl06pI2IgjobNnZcl89nAJmkyjNY4VDyg/09S9t21GoBFR3hOC5gkDYCa9BONVlP/Lt6uURHXuC6hsd+/NPfvOOGgb9cuWwwW2xrp1wu3zC8f/8f7dvzw1edjDcyMtJ8s9DOESzaQAHoKlXoGhwUbYdq1lnSzd2b1q/HcxW+72OtxXEUjuOihINUKo4LNFpbjLFINLFbmcWYkLHRgDBUuG4Wq3Psen4vx0Zr9PRmufXW68lk2yhNT9DX000U+JSadWIZUewQNzFZ45nnql8dWuX9tFpvAlmkNQgRizlMS99iY0mcTYR2wrb80k4Up4Fh1tDIodi+nA98oPvwt3+w4zrhHvny5vd1Xrl0WS/CumSdEjnHJecatIFI52jqBqVGG/ufGufZ50s/nPb5mMh3M1U9ls9kXHTdUp8usbirA7W6j3s/evDz5cbIptCXpq3QBUBkq6BjLUoxW0RrQTOokPXg2Dh379o5dqy/d7EX+JpyqUqx2MfyVUWeffE1rAWBixARQoW4ro92oB5kIWsZ3KxwnF5e+OoRIqVwa53kAwcrqwgMyrShjINj4nYI5Wz7nCtaSEyhneG6z55ahfKiHrSQKCMRVmMFcVuL2JlNYYAIK8FXEYgIIyOQBotLIYgY0i4dh4+xxXHYungtxWrIQNOhEDQxNoJMDgdDf7NJcTxgVb6DN/wSzzcaPFeu8HpPgSO5DKExCOUgjYoFk1KhRSwSc4xE2VggFzqA0GDjJYhCgq4CPy0dZ1W2n6uaks4G+E5rm2fba67bXEsYKZIYi8V/BiwoK1HaQVkHKRwMsVhOS0PUneXl5uuMDU2w+oOLGVoZEUXH0FGdQlFizIkTU/J56OyEVasEQdAgMgFCKJr1PHtfPRzsfY27N2zUFIsufmMCZUERL5YaoayhhIvGQcmG+MAtfP7Ga/ppTk1zYDIkk8vidCpKVhdUd4E3X+aWyW8f+MaH7xF3CZ0D6jgmIhuBUpJjk2UcBe3FTlSumz0vv8Fzz1de2fMKv/hzd19z5Mnnn8dKOXPGnxWst5zDkn56HqcWKw1NWaXWaKJUllz3qn8OPPnP33vixQ/u3jv126tXDHxk8+a13PyBW9jz8i6efnEfgxP7WHfFarp7s+ioghAuWgcgc0g8hPAAgZQO1lisiYgFofE1tJQSYy1aG1xPctWmZYxXXv3Rzqd2rVr7vuuOea4hVK3kuRJjIsRp5hZZYXCkiDsILgiN0AIjEudjLHUJgWzd/4lZsZuVZK15ds9rw8Mb1q4aEqFPwVU0myH9CwbYfE3vdV4micWUlJR3AjuJRRdf4/wf4J/Mg8STwM44yTq9fn93cg73f1uJx1lOFvH8LvHY2me5/OKuzqQefzzfF09BKk772WOY2UmuEB87h4iFUJ3JZ1vnfH+aE4+DO5mdOPpOYpq3jiFuZVbkBbPb2qK1La3f7yRun+FzLPuzyW//bp7vdTArVpvLyQYKnVy4wK7FLuKx4eGLtL6UlJSUlNOQCtRSzsjpbhovlgPF3HRZ78Yb1NYD9stF2n6XtvxLHf/z8W7cp+8mTvNwf5izvAm53PF7qePjbNZ/phSNl5vLXadLffy43PF3qbkM+681MNMSqw2d6cuXuv3f4ddf28+r0JPKv5Rc7vP3peZCHUAvRvmXk3f79e87nXwhy1e/8MX2W67oWKeNISNcpDAYqzG4PPH0+D8vXdONkZZsLksUtdJnx6+hraFQSOGhLEiafP2fHrtnzVr+7S3X9d+0Zd0yFBFQptADC3uWk8lkrpgqla7YsjHAb0SJGMwDYN36FewffpPdL+5l/for6e0p4vtVgiBACIFSDlIoQGKNQrac02yEMTp2HEoEOlIJCCXF9m5GR8d58olXKRTgumuvYmBggEqtTq08ipvNMDUxRqEQpxOxOGhh0Hi8MXII6fI7xmYRMgdaxGKnOWnEtY195SyzQiGbiKLMnK57ghBLGIx1qDRCCm6W27YOvWzE9LqHHpr+veuv9T/d09m3sTwJhB4ijLBGYrSktw++//1XvztR4cEPf+ymh46NlvFDxT33XPelN19+5tHHKztvHT2Ivef9k6J3YAlLB9n42NMsX9gv3/TrFaJI4Ng4YaA2YCKLsBalLM0w5BP3rpv6/rdf/tzKoWP/acFAXGa1UkHINlatSrJY4mCFgdhPCZWBrGOo+BWaTpXuK4q87xeW88YPx5lQGaJ6G7koIhM5tFLQCQzSxg5f5+XNCwRK0sjleXrfCNXeDsrSQSgvHvSyJqljLATDmjhzobQYGcUOXjaiLYzIRYZ8FNBXb/I+L8+Ni1axThvyR6YoOnmCWgmDIZ/PUyqVybpZskrQriQ06/R5Hit6B1mnLN+dHuPVRoMpz1D1DL4DgXKIsGjhIIxAW4GKBFaIeITOhggTp1Fs6ohqzmNvXrCLKitdSU8DnOTQZ+a4gcmT4msucfzJxLEtTrEqrIMNBHhQ9wIa2SojtdfQqyJW3N3Pks15SqOvkHMg1y5QnsDKWDtnsFhrUApWrYLFixcRNo9TKhk6O3rYtXuSl3fzuV/7ta1TtZrg+NQoxWL+hP5giAWDRoYYEaIEK4aG2NjbKZg4PM2zz5St24aoRzx6/W1rvlRq+Hz0Ex/xK9OH7v7q13f+cl7wqfUr+KAUPq7RKGOolX0wsO9AgyeffOHFXS/wd3fftf6Bzh4PaYsIXBQmFo/ObbuWaPQtOSTPHiMMRkRk81lcm8fDo6k1azZv+e5Ad/a7zzzz2IZdr49+Ztlg7r4r1g4V2zprTE0c4rkXXmfFUDcDC/oIggijQ3QY248J4cYOaondoECBEMSnPp3UXWAkaBORzUuuvmpRobrjyPbHfvTM+pvuvkZLIBKxuMBYizzVefMEBzUBQiCtgxUCZQ1WCGQs/UVbgTWxD95sCkmJtR6HjwRf0ZH4nCVAujki4VCpVXFc1u149vG2jwlTZeYXKSkpl5lpYjHCfcQT287JUZwTnYDmdblPr9/f3ZzDPmvF1XbeKlLrIBak3E887vJ2uxO1hGmf5dxdsErE40TbL3KdUt59DDPr6P9eY3vy+nb0zW3MZko51/PPxRJWn8yf8A6e6J2SkpLyXiMVqKWkpKSkpKSkpKTEnJdjV0pKSsp7hcCvUsh567o6Crme7h4iqzEClDXsfmUfuSzfb9QN2UwbjusQ6Tpx+s9EXGTqCOFSLtUYO3hwpWNr/9dH7h74+S3XrKazIDB+CWnCGfcfABv6FAsAWY7rKtlcBicLHR1d1Msl9u55hcHBLgYHO6hWq+goxJGSbDaHECJJg2eQ6PjhpzGgNdZq/MAnCHykgkKhgHIUO3bsoFq1LF3aw/r16wHwfR9XWJSnsLqJUILAbzA5Xaa3tx+kYPjAcZ5+fvqvlq7pP9JW7GRyuoqTLcTujCJOHenYWNzRErrMCGOxWAFJEscZ9zSQc9KARshsQGAjnHwRyHPtDQN/kc20/cXfP/jc+kKOX1+5yvx+W7GA3/CRymXxYB/f+s74C5/81c0POU4OIRoIU8Q0BlizrOu273/7+/etX8t/y2Rcx/d9Jo9DGFA5ejSiq8PDaIsgF9dFgI4Eyond4LSWhAbuuWvpf372qQP/5hOf6OyPohoSQ7E7TxTErmvgxA5LUqOJhXnKDSi4EGmweZ+etW30LljBw//wIh1jea6sriYbddKUlkiFSBEkcTRX9DI/c52ufMfhNaF5M+cxkfHIdPfRrAQgDFZorFA4SLSVWBFhhY3VVspBSshUQwYmNFdYlyu1ZaNT4IrIpXO8gmtAGYnUTbJKAS6maclm2zDa0BQRdQzWFVigWIm4RjmszS/jjajJE7UxXiiNMbWwk3HHUFEu2sSuhJpYqCaFjVWCWKSNUyyGkaEsJWF/Bz8ZP8zt3UvpqIT0FDrQfpNQx/1zph1OKV6WCBO3qjJgkPjKQUgHp+lTC6Y5WqjwSvNNOrfAxjvaWbwyS718lIH+LhABBo2VIZGAcE4RCjh2DMIwIoosfgOanmDHU42xW264+j/rUOJ4LkpamhgCITBItDRx2kxpCVXcE7JQGRsHx3Xp7eukUi7rFx7lM1vvWbytVlUYlUHZbvKe5qYbag89uf31q1au5oNtHSHN6QrthTYqpZBvfJM/a29v/t0H79645+atWWqhxGuPMKKCEhotJCJxOmxtip3pr7FYrdUnpTzRme7Ef4BI7A9j50SRCAAFxgqaRqCMh5PrYLzhs3zjtS8t6uv93SceffjfHx579XdXr1jwv25ed13bweFXeObpSTraJ9ly3cqZwA7rdYJmg+6uHhzl0mhUcVx1YvlCJnWMBR9GRyxd0k9k5NqGf+hHbcg76tojtA3iJMP2hFS6M5tjgUQkijBgk4TEQoBSYCVSgFsPcQToVh7mlqDPWlwrKE/zg4MHRj+3ZlEXfqWMyubIZQt0dObyEy8dXIc1z8i5IToTtzNSwVPE7/lwoet5t8vn3u31T3mb2ZYsrbRonZzomjPM7CTOlmPOXBedlJST2UksAjudO9Iy4KvEIsf7OQuB4wUylNTnPs4vPeMjyW+HL1aFUlJSgPhYsYn4OHCmlJ+XmrSPp6SkpFwGUoFaSkpKSkpKSkpKSkpKSsrPOAJwpEU6Zk1bWx5jQuJElQojoFyq+8Ws86RDBqkFBBHKJqkDE5cy5UgksO+NVzdcMbTohWuv3ugs6s5i/BqNUhnPjR0AXdedKdckohBtBX19fRhhcLOGhl/iW9/czdKlBVauWoaQmihqIoRDNpvFcRTGWKyNZVEajTACa3QsUhOGjJfD81xqtTpHjhxj76tjdPfAps3LWbZsOaOjowCoZEtlks5OJKkPFwwsxNeaRiNkx+43o1wH/8rKdiLtIZ1sLNyg5V5lThB/2LkKmDnbOitOeytGxjISaT0gSxCGeE47P/8L79/T0aY/99iT2z+4ZGjhle2deRpBg2XLu/mVX/X/92eefuHG8eP8+fEpHr7nrnWNUi3kn/6/J8Td72fDtTd1Op19C3hz/yjHRvnrrm7GsFBvxgozISXGOrHcRBq0tYBCWoG2IYVcG5Uqf3/kcOkPhpZn8RxABCASHUuS2tQgwRi0iIVLCHAlaDcEphEy4o7/cTl7vj3Mvh37GRCGjFvAswInNDPuXmfLyWkY645kR2WKg7ksDeXRqOtEgGPQMhZRokUsTFNJGs2gSTY05GtNuiYa3Nm9nM0iz/qsYFGjQWepjmsMTSWJpIxd2ARIE6ewtVhQETpJDxopgbQyXmcjoFhu0u55LOxcwMZsHz8Y3UfOtYxlXWq5dmoyQ6hN4kgmIQKwGBHHtLACX0eEjsvxrGJXbZRlC/soHa9TlB7G6Lj3JXF2onzphNYCSyJRiuuuBdh2Q6Pd59XwTTpvhs33dJLrqFOq7CPjSKxox0gDQmOFnolnYy0YSxhBWy52VomMJZuBQ4enqNV50PU68A1AhBFgjcUgsUJikZjkPyxYadGWsdeG+ZvDo/XfWDbQyXU3tjlTleqGr3z5sPjErylbj3w+/7d/n1u4gPfnsvz+L/5S7x1DywRtbQLdhINHK7y4O3zl137tij/wo078poOUGSQRSpSBlovemWNM2NlvnKRHmzcWlXFiWzhr4j4iJREgE4exsXLIxi23jWVV84++//VHv6WM/8Sm9csZGqzz6suv8ZMfv8mqVe0sWDSI62bJ5gTTpSk8z6NYLBKEPmAQiV1eLPSN97pFUK5MUxCGocVtbL1p0dYf/nTHQxtuuOGXba5ItR4w94B04raZeBuEOeGz2S/HL05LEGkEVmiEaEWcRFlDLseT+4eP+Cv72rKFvIuWgsBo2osZcjnWIMwzZ9eiKSkpl4GW8Cwl5WKwLXk9Uwq/ZcnfH2DW0X47F0+sdh+x69nHL2AdqaNSSsqlZZpYQPoAcV87OZ3npeSRpMztb2OZKSkpKSkJqUAtJSUlJSUlJSUlJSUlJSUF5QgcwVBnVxFtIoLIotwMWId9bx55sa99QdWPHIQNMc0mGWkR0oCI0ELiyAwYS6UctRcK2slly9RKh/F0nnavgHEcjIBojtOTFUl6PAlRGNLe0UUmk+E7X/02HX2w6srlaAvDB45RLBbJZfK4bktCkqgsRJSsK4rdsmScgi6TKXD06CiHDx+lVqtw862ryOYcpJRMTR8miKpIG4s7hAUlRGwLJj0iHHJeFkdlOTiyj/0H+I0lq5fUpCoQRgJXZbHoxJloVtTSSt1pxFsNrYRIajzz+cmCtjjtpUnWJh1FpVmjo62NUuQzXuIjDz/2+hs33TokUAFhcJBVqxwW9S6448jh6TsOHfHHwurLb4Sa4OY7ueq6W7u6h1at5ZU3xvnJo1M7Jsr8Tu9CRRBoylVoKxiwPiYZGjIyQKHA5AGDtRO4GYfyNA8fPmz/YNlyBysiEGGcCVATp1iVDkiNtSBNBIlITWoQNorfuDWiguWqDyzite4mr78wwkBpIQPNLpAKtIzTb54FMnF8SyzcAPAdyTMT44x0dxBpBz3dxIpEIOc2Y/GNVnGbqwipI/obmu5jJbaoDu4eXM3SKKKnGZCrG7KRQQsHrQyhMmgZYVQcJ66VSCtRxqKS1JkSkzjmGYyURA5YK/AIWVETLIpcrupawe5micfr0+wsj3Os2EY504YREUbG6Se1iWNBi7gsYeKY9JXDMxNH2LJkgEHfozHdREkJMk7hCLFQ6nSiqlgc6eBoh5wG3w14wz3GkdwBVt7bS/86F9ebxjQC8p5Dx6IBGv4kVkYoGyZBeuI6m3Xo7SYWymlJsWshu146ynSFh7WUGAIsDtI6GCtxiIWBysZpSiMriCxYrRBCU23y2w9+8dDmT37Mvm/VlSv45YFDn+tbMvnpSvnAi1Lh3XkrqxYt6upfuaqHbLZOLRilOZmh0ehgx+6jRhs+0gwlDR2gHVBC4aBR1kWc7Fh4ERGANA5ulAXrIAhARIkgDrAORji09RSZnhrlp48/vnjJSv63YlcOS5P+vjaK129kYtJnZOQYO194hWVDS1i9YjnTeoJa/TjNsER7e3viPCkRMlbAWmtn9nkhnycM6mRdh9VLu2Gr+8mv//ip8oZbPvAZV7YjjRP3x4QTRJ7Czgg642ORmTVIS7bDEiIsWCFjBzoRJn8HY+HeT3y4cvS1Xbtd173WmJBmqKg1muRzLo5kKBbunU2DJkLCk2P53ZmZPSUlJeVnlW3J65lEahC7mn2KWWHKI8wKJoc5e/HIpmS5l9gN8Hzc0lqkjkopKW8vw8ymnL4vWc419efZUCIWw24jFaalpKSkXFZSgVpKSkpKSkpKSkpKSkpKSgqOCMkoM9ReyMYpO8MmSjlMlqtEES/l8oqm1hgTYUyEQCeuY/HvQy0QQtLRzWu1eimSqsMhishkLFIatFQY0RqGMDOvRsSiiMhAo+Hzox//hJwHV2++ko7Odo4dnaKQK5LJZHAcgZQuwlgQIdZoIMIQEkgdm1AJD2kcHn9uDwdGJsllM2zYuIm6jpiaKgGQzWZxs/GzK2MsaIGO4vScRgsi4TCyf5yj4yV//6Gxv7vvNz744NM7D9AMBZEJEcoijI3T4kHsSCXMjACm5QwXI2e39wSXohOxUmDniDIiG5HNeUxXJ8lmc9x2x/v3/bv/4+HrnPzYl1YM5YcG+l26+zpRts7G7iWsu1L3+5HfnytkcV2XoGH51veeOrRzF39+3Q0r/uLo1D7qVU1kIJubW8cILEgipBWJmAesUdTrEV6GVyONtVIJk6TjZO62WYlBIKwFJNKY2HvPgDQGbADSMFmtIgs+y27vZ/HaAQ79YIxjB8t06nZyYQ43yMRiJtFKGxuL0UQiRNMyjhdpYiGWsZbIEdQdyUTO4YBpUnYU1liiRh2yGdBhLJAjQkZlcpEhG0X0NCK25Lu4cfkGNpgCHRPT9Fkfz0RgnTjNqUjc4eY649HSzZiZd9KCsRLX2JmodhyBwcGzAlUL8GpN8hlBsa2DFYsW8D7R5HuHRhipT1PLZKk4Ct/JECAJFWAl1tj41WpqSjDsCF6oTjPUPUj1yBu0txeIBUUSYSXCxI5+cX2TRrJxK2ohCaXEOhFCVCkXpin1jbL+55aTWxXRtEfIKEN7u4dSLrXSMXBJBKit9o63tbU0m5AvuBhraQYRoQ7RYPF4tR6E4Ok4rqyXCPqI19VKS2osypI4xsFNN18RdrXZLV/7xt7fv/3mo783tLw4+PGfX9jd1Gqrl2mn6Wuk4yKVxWKwqoc39k/z8gtH93/ly3zyf/mXW/YdPT5NrruA1SEoG7eNnnWCPBMqSdnZEmTFwk2JMiZxSZSzojNaYkAZt4eJY0ZYgxRR3KeI4u8korCHf/DPspDjd1YOFf79bVs2tLU7DTJeRL1eoulr1my6lr7+MV5//RV27zrIkUMHufLKVfR29wAQRg2k4yCFh0liE6HimLTQ3bWAybGjNKoVcm2Slcv6+NAHcr/xnZ8+ojdvufW3PBue7B/nAUGcfzhJRzyT91TOvic+VsRJfGeFtq1oFwisAK+Q480Dh/Y03zd4bb7oYSwEUUihkCOXYfmZW/9kzs1RMSUlJSXlHcm25PUBzl4wdnuynMwj8/zmYjBC7Ob0tYu0vpSUlHNjmFikdj9xet6tzIpPz7efjxCL0S62S2NKSkpKygWQCtTe4dRqtctdhZSUlJSUlJSUlJSUlJT3OnaMhx/8Q4oZM+A6FiE13V156kFIuTxNYNnnN49jnBzaaFA2dspSEEsVBCrTThSFbL7u2onjB15+Y2zCv6JNRmQLDYQSBJHEyWbQJmTv3lc4dGCMvn43Tt8ZGgr5fg4dGqPQBhs2rkBGDcrjIXmZx3GzeMIgrEEHIQpFMZen2Zim7pdoiiZhIY9284werfD6y4fD/W8G/xbDDqbE0OvHXhps79QdCFsAFgFL+vs7eoAsYKV1apVyczIIgvFmEOxFsE+bzO4oEi9ZKUe//NXvESHRLSHHXCUZEi1g/cZ1aBH/G2TsqGVlIkozdHZ1MZMSlRPlF8YYtNax6CMR7OQ68jiOg+NBRrajwx7+9ed+cUdPr13+3W985Vf6eviVBYNjN3X35HqyOYe2fI5GrULzYINjxywHRmj4dZ7sKDI8/Ma+X+ksiHzdtxVjmBKWyUyOV953zeq6tJ1ks21Mlo7jOgYXn0K2nclxh0h6NJpMSY+6dVTBCDg+NcbmzQM8/pNRjhw6zOBil1wg8VwVR0Ii6LEtNzhhsCKid1EbfhBRbYyQ6cuy/hf62bdzgp3PH8U9luW6tmtxqi6+rSejVQZpNF5kMQICRwMGFYKyEiMEUVsbzYVdfOmpn+L39RASxu2XF2CbgAWtULZJv9ekv1llXcPlptxCrsn00l0JcfU0nopQ2oJQifLIxu5UwqKSJLBKx3tNEDv+xeI+i5UKhcCaOekhhUIRZxI1rsQCkSPINC1Dx3wGHMkV7ct5kzpP10Z5uRkx0dPPcdclsJrAWHQibDIC6gpqfYt4bGSM2wf7WdbTQxCWQRpU4lLmWRdpIVQWIy3KszSbPsoUcNvzlEST4eYItZ4jLLqhyIqr84iuo+QKig4EGWFiV0ClcVQiSBJxEyKByMGvR9TrIWEU4jegvb1AIV9ganqaqt9kokzdKqbqWpP3JKHfxAYZXOlwx+23U6tNUewuom3EV77yVH7JMnVlvlDonp4udw2/9mr7mwH1IGT/935gnlw4MP2RJcumcwOD7bj5BiqboeFHlKablEv1iXI5fOLoYf7hhs13ffH3/6Cfam2arq5OtPSx1JCyiRISSyweu/HGG2fa8+Q+LI0kqDUTcWaEFg6BzCOMJB9FcbtKh/7BBYyOHiKMIrq7usjlChw+NEY+n6Orux2/3iDrDKAsBPUKOWX40j8+3NPfz6euWsDvLFnStXz5siV05C06spgopGFCHKUYP/AK+UKe9RsGGVreyY4dr7Fnzxv0dnaxZtUK2vMZpqYn8ZsaN9eGVyhilZMccxwq1Yh8oRfpZGj4PrmsYM2yPoLrm//ziy/9eM2VS8gmZmePYLnGczquGh31//qG6z7wJ/n2Th769j+h5azDWiuahRAnOEJK4v4oknbFxumJ61ZThzfHpibo6R6kkOvAOBkwHsVCZ3/c6KcQnbU+O1m8+xYxbypYS0k5X9LnCymXkW2FQmEnsVjt6gtYz8USoZ2KEWJBzLZT/bHRaFzColMuN+/1/Vuv1y93Fc6XYWBbPp+f+9lQsmwCOk/6bJrZVNWt9zvr9XoqSEtJSUl5B5IK1FJSUlJSUlJSUlJSUlJSUhA6wHXocVXs2hRpH4FA6witOWZkQChAxKo0ELGHmJs7eQAAIABJREFUjhCxQ9PhqVG6O7qJhMPB0dp31yzliiuuXIWuHSUI63T2DiKcHN/85tcJQsttt1/FocPD+H6dYrGIsh5rVy8hmzdYE6GkQkoP5eRwVJI6z4YILNiIAwdHKOQ8MlmJVQWmQ9i5ew97duuvlib5g7Wru/dZXcBEHtZqNCUsTYwxWGt5cW/JBTLEEpx6IdtmlZPDcRXGCozJYUQstNIiBKLZHIoz2onEb0zEH7b0PPEXVCyyEAaROJTN/lC3mhCIRR8Ig52T104KTXW6RD6Xo1SapD3nksvlqZYnGT/KDxtVBn3frh8/Xu/xstDVUUYBpUlYPuTQ12fdRk3/kl/nlwLfo9ZwCLTBCh8rQTkcr5YPvjx65PUnJ47z3WtvWP1IW15iwgjfD+jp6qFRK/PGG8gNVyGkELGDVJIKMNLQbEZkM13UalO4HU6c7tDODjVZMdtYxoKXge4cBIFPvXKAlXcuom11P6/86BjPPbeTVblV5DNZGpUaOcdLHLbi9Yg54hYrQKBoui7PlqfZ7ykajoe2Ais12AhHG/IRtEWWgt9gkShxS18/t/YuYnEZekt1shGEMinDMsdla9YhLd5PJ8gJ4//P2TaQJ6bXtHZGeKMFRDKOI1dDITR0W0OnK+nJeyzoXswVIuKRYxPkHZdpz9LIu1QQNBN1mLaKknIYlRl2T5fpyRUQuo5rIhQSaebURURYETHt1/AKOXAM084Uz42+THatYvFN3ay+tYeaOoiQPjIETykcZRJ3rFmnLGziZWUESuaplMsUO4q8urdMIQc93W1MTU3ielkWdC7CcfcKXyOl49EMAoyxeDJESYN0ffbuffH2UPDBxYP5G2+8wVunTdRrKVNsA1eCl3HIZQSeK+jv6o7CyGdqaprqMfByUK7AsVGYnKAURTyacfihkJZiR55yeRTPtTTCkFzORUiwkUaKJB1mkkK25WxomOOGJmPnQGnjvhxLIR2UdZBGoqzBSkFU9Wl3i8iMwi/7iKZP3svgSQWhxhOgTIhp1nnsRw9fuaCX37z+GvHrq5cvKi5Z1Bm3sQ2J6nWMAFdJsm6OjOcAltL0GIiAQls7m7as48jRMrufO0S5McKKlZ30DXST0ZZSpYFtNnCygBPHntYSRyqymQ4MDhNjEwglWb24gyV9V94RRs1WjNxs8WgrDLB//9T9Tz76vc5b7vi53wMTuwfCCW5zApHEQdJeMonrOBdoIsRNUtNKjmpx4u+TftATi3VJSUlJSfnZYyexoOR+4I8vb1VO4IzCtJSUlHccw5xb6t+UlJSUlHcoqUAtJSUlJSUlJSUlJSUlJSWFZhTiOk6n53lEQRmrJYGJxURBQMkjTs0nWs42iSDHJqnv2gby4EpKUyFjx/k/9++f+u3VAwOZrqyLqwSV6RIvv7GLWt1y080bCYKAxYuWgDAEzQiMIpPJoJQhDAOUlHhuDtlKC2pJBF91kBHZDkm+rUAzgCNjJV4cPnp858v695cudT/f1+XgeV6smrCx29vUVNBaCcZCR4cXWmtDiNNZYiXGGIIwiN/bDBbBHNVZLGChJS8DI+J0g7GjkEk8fkwi3Atb30IKEGTf0uYt2ZPFgrBYLNJCFEWEzSYFx0VqzYIuxXe+881NHZ38+sqV8qN335UZ6u526Ox0cbIGRICSIdYoOouLGNk/SthsOEETCm2wam0H7fnF1Js+Nf8ovl/n+HjYu3iw97ZrNuVve+21/X84MvL67tFR/tO11/T+t/ZCH8fHD9DT1cnaK1BehryQyVYngrsF/XB8FOxagTWCMNRkvKS94a0pFVsCLhEL1ZpNaDSP0NHXzS2/sIq9gxX2PL2XvkobKzsGccoWV0tCFaf7yzezcdZK5cfiHpGlqQo8OTHCoXwHvsxibbKzhGaw4NF2dIIrQsVNvUtY5y5nifDwaob6xBRhJo9x41Sk58SMSI8zpmyFOPxaArtWmwQqLtMx0NsQ5LRgUGXZ0j7EXr/K441JdtWmsO05hJONU3daSRPFpOvxWGWSVQsXsaARUgijpAyDlhGhiEAEaAWRyDFaKzPlvkmtWKf3zg423b6KvqGIg6O76OgG1wPPy80IKeeK8ma2wcbpd4U1KOlgmgUmR8v09YPjavyGxXWzlEoltCEvJE6j4ZOzRdryivEjr/Hy7v2fWb6Sf7n+qsLGoZVLmJw6QrlaJ98GxQ6HtlwbHcUFVKerTEwdpVrWHDp2zFm7OsfqhYuJwpBStYESGcRVCmv1inJl+k8nxqM/PTzyo+EnfsI3qxX++8fvvX5XQWaYrjSRjpfsozDpWzDXhWvulsbtZ7DWYGSETlwRrZREInbNG+gpUi6X8FQ7NlJ0ZDppBjV6Mg7Npk9vez9jU4f5wcM/Wju4kD+8/fr2T3cVHZYPLUJi8NwsYTPCb/gIIfAch6zrkZEiFpiFAdb3sTIg8DJUGorXRibMnsP84qtjx4MDtalt11y7pre72I5WPtCAoP7/s/emQXZeh5nec875trvf3oHuxr4SBAESBHdS4i6JlijJli3ZMy57SslUEpcTTyqpSVypGflHnKlUyuWZTKWye5yRYznOeNFCU6QskZIoEdwBYiOIHehGN3q/+7ecc/Lju91okKI9msgjWzpP1S30vX2Xc8/yoarrqfelgI+UHoIIk3lIX1AMCxQ2FFhcWkSnKaVCSJpZEFlfYEywZpZb94+B3fgbR1772nUE/91qBfP6XS2FWDdP6+fwByaaNYwA3Z+zvDQZgIG/8qCsX4t10ud6JO89ay5RzeFwOP6O8QVyGewLwK/8GMfx5+S1oy/8GMfgcDgcDofD8VOLE9QcDofD4XA4HA6Hw+FwYIxBeaqopEQbC2TYTGC1IdMkwV/1WgE906PbTRmpjHH74YPXz7599MEgffWVR+/fIsY3DHPp/BxTUzM89uh9aJOgsxTlKXw/IIrAZpIkSdAaCoUKnpQYDcZkSNVPILMZRiZoCV5UYqUHJ09d46Ujc3+wkvCfbttVX+y0elSrFYwBbAZkfRtFsiY1WNEP88nT1LACoyF/4urtgxHrnyFy6U2u1t0BSmSARaylphmk6OR5a+vSuNYLahK7Jnf5ClqdJoWozl/+5bGtA3V++7FHg1/curVOpVLAUxmt5jzlig8iwxgYHB5n5toiR753kVYLNm9R3HnnJjLT5ezZWRaDBSqVGiPDJcrlDRztvsOZU1fZvrPIvn1j7N6lbpufa/yvr706//nl+fl/VPR492ibsFzi4xOTPtpkeNLkJZfCMDxUY/ryCo1Gi2pNEcc9At/74JCkNQkKhIRqDdIYdNrGZHPc9ZlbKG2QTH3nIu9cmWeytIliXESaAE9LAp0LgrHME/u0H3K1F3Oi2aJTLyOAes/g24Rq0mNweYbHN23jvuowm3qa0a6Gdht8j5GRDTQajdxfFNycfvZvw18jpr3v6Rb8/ktW6xKlhSiDQMOANGwUKSNRxOTIVg4ow1fOvstiKOkpSSIh8yw6CjnZXOZE3KOmitRtD2UzlMhIvQStElIvo+cZGqHmSvMSxV1w+8PbGdxdI1MLNOMlJoYDApmBNWTW9PPi5Fq97HqMBmskSdcyWJtk6kqTXgt27VG0myvUB8q0Oj2KhYChIWgu87PPPvvKMwNVep5k5/ZN/O5jj5Tu2blrklavwdLyNKdONHjgQzAxPoyUAfPXFzh5/DQDVZgYG2Rgd4VTJy/x7jtdZqam2LevzuTgANoYkrRFnLQZ3Bhy686NNBp268JC+uunTsz++huvH/nD8xf5zac/efhimsV9oSrBCIOyHv2swj43RMo8Oa23bm3XpwBKpDF0V65z7vjRX7LGf7TZbL+aJPp0FKnXDt91W7saFlm68i4vPvu939y7h//2vvt3UR8whIGh05lDioBeO0HgERUihBBIIZD9dDKtU1aW5yiWy1hRYnEx4+vfvnD17FWeeuDD971dHRnh+Re/vPfai6d+945bJ//+tokh0AalE7I4JvILCBkgpCXTBk9Bmmnq9TpxHNNpdfADla+vsAg0vbRLEEtu2buB2cXF354+0fmKMdlxKSUYg+wnpYnVWuP+PEkLRrxfDpNSklmSzBqkVJj+tUzmzy38UAfGyWcOh8Pxk8pF4FeB3+jffhXY8u/hcy+Ry3H/qj8Gh8PhcDgcDsePCSeoORwOh8PhcDgcDofD4UBjiYrFIoCUgoGBATq9FF8toUCtPs/2xQPRT9YRxoCA0PMweMRJQm1wiI333/fai898/5OV6rkvPzIwzLnzl6nXqwSFiE4rJooiIMNaUEohfVAyQmuJyQRaCISw6LRHHHcRqov0NVIEpCai0VV8+9sn7ZtHs89/+jMf+b13zp3BCEOlVMFqEPJm68gYAci+INaXL8hlISstAjA2yTsArVh1xd6HsWDN2lv06zslQkfUawO0Ow38wNDuLoPIcrFOJNgk4YVvT4dKUC+VGE5SykAoLdJarDVk1tIRlgYw9+GHNjae+/qxz9x1KPjiwTt2hLXBNsasEPgxSgqCuiDwUnpph8xG6G6Vo69coViFJ57Yjhd6vPHGGWavweSkICx4nD27xPmvL/HE4yM8/OEH+c5L32VutsOWzZP04gY7d5QZrtt73n5r+XsXz9B+9OHxwszMtCwGApslhJFHmlgUglKhwNWpFV56qcOTT/pk/fnyg4B2q4MXrv7JaVU2yUU9VucP8EPw/Jg0W2CleYTNt9cY37OZ6VPLnHnhEoVripHGRjYHG4lUBjol1RAj0IM1TizMcjWNafZgREQMNHvsTCyHK4Pct20v1aSHv9Qk0IaOtvgSRJbRXFzG6+9fLVY3wo2EvP4Gv2ndf3iJLZcgPUu/gvPGLMBqstpqypQhEZoolexaSBn3IvaN7uOMznh1eYFzpstKIGj02hjPcOT6VW4rbWLUCmzSw+gmXklDQTGddTi9MsXwYcW2/UU27hlADXVohUt4IkaaGM/qvocpUNasS7vL1UvRl+iM6SeoZQZPVeh1JKdPLnD2XTh4p0+j0aEQ5fW7SqXUy3DH7fwvw6MVc/bdZnd0iNLt+31Ghw1KXmG4XuTi2QY7N8Ed+w7y9ltv8/JLhnIZDt0tuXbV8PLxRbZtWeTw4Q3oW2Je+f4S33lumUcfDRkcLmJCRaoV3U6HLBYEvqIYxvzMR/ZxeWrlF19/c+pnn332tb//4YfG/99X35iuLi0zsmGc6soKRfK/gwoDxlpioGUE81iW77trc4z1kNpghQKdYLSiHJXJlpq88drL//LOO4Z+bcu2cZaXFz4vhOD8+anrR7711j8QmleHavxPP//05s9s2z5AnC4hDXS7Kdb4yKCMHxaQUqKEXbt2YixxlqHTHgOjdVrNhPllwTdfvHTswhyP3P3gocXS4ABTC9e455FHFqxp//JXn3nlm3fdOv+/37lnq4yKRWzaotluEpVDlKcQUmCMwZMSjCX0fFSpisBHKUD28sRF0cOzHoFQbJ+Y4OjJdz+fpPofJYkmDEGs5kRK1T/FIpf5EIh1Gqrp/yyVxGiU0QalJNrm39PzPcrlUvGDz8l7H/ighLYfNurQ4XA4HH+LWSZPUvsCef3np4CHgQ//CD/jKHlK2r8irxl1OBwOh8PhcPwtwAlqDofD4XA4HA6Hw+Fw/LQjQCiJFXjGWjzlkWZpLjooReBR7geF3XjJuhQdJcDTEovsJ+xArCQf/YW7v/LsV1/5dVE8/j9WanWiIKTb7dLr9fC9EIUky/KUMSE9hBR4+LkgYizGJGQ6xdgUX3gIHZDpgKWO5buvnDx97B392U/8wsePGVVEWx9Mhukn/qzPSsJKrPHXfn6v/GBtLk+JVTNnVcIQIvd4rHmfSCEAZddymBA6YWl+muGRKo3mPG++drZSKnJ3pcadUYE7uj227t7B9qEhqlEkoyAI1oQo0zfUrLWrjy3PTl9buGUPO0ZGPc6eO0VlDrZs9qhVBsEm9LKUbreH8KBYinj55RNEERw6tB1jE868c55z5+HJJ8YYHd2AtSlnz56kVIS4k9HrJpQKAdemEtJkCeW1EEC5Ijh4oMLGIUoL16cpRFApByiZ0lyJEQhKhTLT0zNMjEOhCO++m3LwoKLRyAiCjGq1SJIk/ZnqiyXrU8f6e0mYXPzy/BRPpCS2Q+IFbLxrgE1bd3P9jSaLryzyzuVZRsMBCioiMDViv8CMtLx++Ry1ikK1euz2BQ9s3MS9pWEmOxnlpQaBSci8jEzkIo0ReZKZ6iearTqL76sj/RGxmjgFNwQ3KfIZWa39tPQ/XxhCYygkMGR7DPowEgRsHpvg3azDkWtXuNSJSYseU40FGpVx4ppPwfoIqVg0c1zpLpCMeBz6yCYm7quQlBfQUYOubaKByANfS4QRN3pq+9W0P7jgE7QBoyVxB+ZmVuh14a7DcPVKj4OHRkmS5VzABGo1qFfB6KY8eFCVDh/aSXvlPNZ28TzwpUdzETZuhNbCAjYxVEIYrMKmjcPs3GJZWRQ89+x1AjXDtq0hh26f4PudKU68PcsTT+5hsdGg1U3xpEQnlkIxJBwucPz4SdodqNUID+7nj3vd6XMH9jNULFGvViPard5N38ve2I49g2pcuXT5fNzjYrvDm+2Y189N8crPfuLhpu7Mcfroy1+8+46Rv3fL7lG0aTKxa4QgCBiuMLpxYO5r8zNJZ/uWSnHzpgJhmLHS7CAzDy8qEBZL+H6A6F/TsBbbv2WZphd3UQKWOwmdruDlI+dfzUzwwCMP35+qcoU0jjEa0jQg05anPv7I773wzLde68yf/qPbd0/ccuv2SbTXpZel+MT4QYSxFmVziVgg8ITAGolJ8xhCgSVpxYhQogJNlsLAaN1vXG+jdQpBQLrW5CyRWJTQKKkQ/Wvie7HWIgRlIQTWWJCgEHhSIIT0f+jD43A4HI6fFt7iZoHsYWBr/3Y7UO///FclrR0ll95e6L/XC/37DofD4XA4HI6/ZThBzeFwOBwOh8PhcDgcDsdqqo8Ag0IQxzHGKjzhEYaMpNycIuX1K+AMksBKotTDCokwGQgoDRWYmV/ijke3/csjxy7IyUL7n++YqNFqtamUixidIpUFAZlOwOTJTQqJlD5S5DV1VhisVrSXBa225dLUXOvVU3O/M9fltz7xi08arxKisxgteihrsH0BzdwkpAF2/Z9AJNaYm+5/YDellWgN6j1/QVmftmWExVcrhCXB668f/wVt+OyD98tHoqIZqFZ8ooKkWAwpV0pkSYIQgiAI1t7HWptLambtTeu3HwzqKytNstTQ7giSxHLmTMbli9cZGoEtm4ZJbReN5sy5Zd45D5/9+c1Y3aXdanHlKnzy6SrFsqbdOYeQRcZGYfME3H3vAVYWl7lyMUEKGBgQNDtdsgSkhOHhISZGt/Knf/w6I2OwYXSQxMysrXtrpcH5d+HhhzeR2UW+/o02O3bpPIhMs1aduba3+jaQBDB51SJWrk25tRrrp0igZBNEskKbebY8vIHxe+qceHmaN1+7znAnYlO3QFAb4NsXzxAMVtnXabBnaJR7BsfY5hcpxjHd5QWk8tDSYPrSpLAiT7uzoIxBAcoalM1Vxkya/ph/dPWCRtyQ3yysfT79n60AvSrIWS+fJ2GQNqOcdYh0wmgq2e5JDo1s4fXleY505+isLHCycAE1WMIks7TMVdIRmNwPt+0fozYq6HCFyGYIJKWggJYGaQTSGDILnrSAwa6Jg/bG+Rbrxg9kxtJpwRuvLXD4rknq9RIvv/YO3bbFDw1+CMsNuGX3No69dYEggMceu5Vr02cZqFbQcQ+T9bBIBiuQtEFnHTZvHqDbWKLThUrZJ0nn2DAR8cRT8LU/g5GhhNGNmrvvH+bFb80zNT2PCqFaK+PJES5cuM6VK9fzits6jI5Cpe6RZhmex44w9BBCYbRBUkTJdWt746xFWC+6ZZsdjXv63nan+7lW7LPtarJ49uQLf6qWsY89uO3v7dk+hBA9PFXn6rlpPM+nVIq459BttDorRV8YpMhotjI0Rbywhgx8VKgwwuRdqeTnXFjQxtBJugglyfBYXrQcOXL2jakp7n/syXuz1IQkvRjlZ4zXRxGFGs1Om6zb48knn3j7uT97fv/Mpal/OrO/+5+Pj1XKIxsKGBFDAoEXIqXFats/axZrEiwaq2MwmoFaBWt8shSaLc133lj+UmliiMJAgblOmyAI1mo6fTQF0UMK2xcq339G4jgmDBkJopBu2kUFfj9tU2Dt35QC6nA4HI6fQF74cQ/A4XA4HA6Hw/E3hxPUHA6Hw+FwOBwOh8PhcKwKagZASEGWWrQFKX1CxRZtApRXQNs4fz4hsKrzSHwd5EllAoSE5UYH4ZWxssTu/dG/uHby1EPN2HzmwuXz1EoBExs3IvBBSISQGJMhUFirUX0RAvKGOZsZLl+cIu2GzM42416T3//M5x4zWnlo3SMzaS45GUCkYD2k8fujywUce1NDnFmrKr1R9ykBD0wEgGckxggsEm0sylpsv67RGJBCILBYmadinT178dc2bOQ/+9BD9V3Vqk+17iFFB0QCIsPaDr4y9JIW4+MbSJI80emGoGbWC2pcvz7LyEgNT4WkqUe5XKax0uLq5UXOnIL52XnuuneSgZERjh99k82TUC5JWi3J6dNNihGMDFeI0xX8MKVYUOzdW+CFb3ZpNF4k8KAbw/0PebTb15ECdApRANVqmaXZeQaHYPeeKkJqJB6lwMNmAVdnlilXoTYQUqlNsHHDGU4eh8N3lQh8S2OlQxQFN+0viVlLrxPrJLV8v8V52higJEgvprKpxEJjiqwO+54eZNOhAgvHUq69Os388jJvzcwyuX0jj9y6j8HFHhubHeTKAsZTDNXKxHGMRSBQSCsR2qDMaiUruUkHSGvQsr9T7M1i3Y+C1RU1q1WiNlv7nRGyL7FJsBqsJJMGT1q8LMM3hnIqKSuPWqSobtjAgBcx3ZS88cZpyvcW2HRLgZGRCnsf2YSIGkixyHLSoV4tkGUJaWywqcAPFJ5SCCsxgF610fqCmiI/u8aKfoVtbqcZozE24s1jM9QHYeu2McLQpxDB+fNz7N0XEgYBYdChsdji1n0DvPHmEstz1xgbqtBrdjEmI0kMUjTZtbfMd7/T4u23F1lcADL48MMjBAEgJfOLDSa3jrBr5xxT05b6UEqxXKJchfmlJocfO8CVd09w9uQFlpZgoAa37t+CpzIy3UXbBtKDOIZeLyP0Mmoln16vc5NgK94jCpaLgnJBMTTgoW2F3Tu3DL78nROfj8Y9tm4ZRirDQG2YN984yrG3l/joY3spFQsoqZBSkpkMjCQq1CjVy8QaNJosS9Y+TBmLZwwmy9BZhsIjw6ObeDz3nRNnjZYPPPKR+zMhfdqtRcJyCesZOt0FwqIgTjpUygOYuMOnPvUx8+3n/uL3FxYWf+3azGL5gC2yaXwMhYePRgUe1mqwKaFSrHTa+X4UeaWr1R5LjS5zs01eOTH9f1Y2et/VBZ/UF9hCRMz6uTJkVuZ1xcj3ubzSgkw0kWSLrwRGaxSrqZwmD6IUBofD4XA4HA6Hw+FwOBw/3ThBzeFwOBwOh8PhcDgcDgcWD23VvLV2IE8Y8zHaY3i4QLFYuLXTK+KFJUy2zEB9gHbL5ilYMq9yfP3IcVZlLws3VToKMuJlfjkI2h+7946R0vy1WaYvLVGIFBsmtzA0VKcQGoTNsDohLJRI0zSvgRQCKTS33baJbtuydd/EUPTWO+ee/cpfHvjkLz3xdjuTDFUHwAisNUhisBqr/XwkIhfBRF8Aem+WjxG5INZYbgG5SKWsQRqNsgZEhhcY7jm8N0+bMhHGRsQ9gfIznvvG61tvPcgf3HFn+f7agM/gQBkhM7A9pMgQwq7VhkJCYTAi7S4hTZ6mpPuiXF7Hd4MNIz7QweoegTCk3WVKkce+vRX231rgzDvXee2lq4TBVRpzsO9ggLWWNLFYA4MjEBZ8Go0E6Umk6DE87PPxpw2XL8U0GvDx+0qUygFLC0v0ujBYDQm9IWauLvHaKw127gwYHatjTIySIa1GjCfKnD+/zD33lEn0PAuLGQcPBrz0QsLrWZvbD9fxfc3SUszIYBmvUIQ4Js26fU9Hrkuf68tRBkLdlxMR4IE2XaoVRWY1cbJIeaxM8eEq1VsHMOfaPL7bI2p10TNvMlbcQS0uYoMiiUjoJV3MasiTVkitKGQKz4BBY4TBeLmsk8m+wChuCHM/GlarTQErkTaXJa3MhcUcD2mjfF9KMCojEZbMWkIVImKIY0tXp0S1IiXbZCK+Rrm6wJ2fU4zskGzYraiPBVh7BaVSPJlRKIYgyOUpofrfT6xLSDPk2y5PuJJS5gmDRqAzS2Y1qYVMe3Q7BV57pYkB7nlohHZvBmSZ4WE4fwF27w1ZXk4QooDn+2wYK7Jn9xLPPTvHk49XGBmucv16g2IJooJmeESwe98GvvmNGXbvhQ2jkvqgZWlhmvpAGV/10F0fpeD6DFhb4fp8i+ENJS7PtOG7r7O0BGMjcNddRcq1QRpzC6w083OuFBgjiISgUBJI6YOBQujdlHp4Q1AFazM8MqzN8rUwhqsXr9Bb6nHo8GGCYoWFpTm+//p3WWpkHDg8TrEYgbHMXl+mUCoiRQnP95CeQmuNEjKvBrZyrURVWlBZD5HEeKkljGrEqsqXv/GdZlv7DxrC3kuvvoWyKZCReprEg9iDR556kHqk8HVCoAL+zRf/fP+hW0pvP/zATmy2TFd3UL7Fk+BJha88hElIu4t045jB8hioEtdXVri6sMLZq+dOzLXM9zLBs6VNG/7Ev7oAqo22BuVLtM4rj6UUucupM6zJL2V5nedqNKBEWUMhhSrsK4UBeAJrM4S0LK8s0ktbc/n/B+9JrVx3Tsx77r+fH+XZdDgcDse/L9rt9o97CA6Hw+FwOByOv0U4Qc3hcDgcDofD4XA4HI6feiRCKHrd9GoxQ6d/AAAgAElEQVSvG+8qFoNc7NCCwA/YMDJ66OLpWa9SqmVSeGgt+glqN6QCaXPJxYh+Q6Bd/+6S+z/0YO/V73/3t56o1/77bRODzE2vsLIUM3V1jqXFZW7ZM0GlHDJ9dQGsxPd9QCOEQgiFlIJSRVErFjl0eBuL8dnn/+LLz088/fOf0Mvzy3iZQGL7aUUaoS1gsUr3h6gxwvYrQG9g0WirSKWHRaIsGGvwRQYiQ1mDsYKUYv+1EcJ6+H7Ct144sufRRzly971baiqIETIGmngChOhhbdpPMeo3ClqwNnf3LPljsu95rMppUt28MgoBwuJ7oFSCVBIlQu45vI+F+TbvnL6MTiztRkK33UNYw8ZxOH0aDty2RKlYodlaIpb5WJSELduhVqsijEGbmFqtTL1cpNeRHD06zfG34fBhmJioYkWXJOnh+T7lUp1XjlxlZBQmNtdod+YBmJgY4/EnBM8+e5n2d5f5mY9vBzvHwnyTctFQGqxCGpPLJ6b/Zc2672gRVmAR67pTNdKCD6gANC1S1SHaXGX3xip7Dm7kymvXaIZLTE29ycVZ2DSwlWppgE6rh0eANAHCKGw//c5ag5EZtl/nmck8Pcus/9i/EfoCGAbIJUkrDFiTz4LNk9xymS0XgLq2C75E1AU6SDnbPUtHNCmMwbZbq2w5NE6vuEDXn2MhgbEKFLwAz89FRbsaB2fzKk+JAGuwUqxbgxxrBNIotJFkmSbVgkRLpCpy6vgcRsPHPj5KFEjiXoI1Kxy+ZzfGnuEvnmnw9NPjyCCj01lBW8WOnSMIOcfXvtLkwMEmh+8cQfkxOmsTJ016SZNHn6yDNqRZis5WqFQKZIlkcHQ3zbmYmWuwdUtIlsXUB+vMzjdYWAa/AI8/OkwoO0g0pjOLMSmBD9j88BgjMMbmghj5+V8Tqla/8zoxFGERajXlzmBEyuTWzVy+2uWtd6aJ5DztxhUGagX23rKRXXt2EUnN8WNvc+nKNe65526CIOzLqAahDYYs91LJBS6JQegeWRojtKFcGmB2JePU5QtMz/MYdTNriZHCgM6j/oyATIAWEPc6DNWHEW3NV//0K97uncHz+/dvwRMt6iMFFpsJvvLwhY9AYDPLylKDQCQMDY7SaEdcubLCm++cOXJuSv/TnXds+nqhZEmFB4UiZnoWKzqsXdNl30YTqr9XPlgQkxa+/MfP+HcdGLpz06ZN9JLl/KVCkGUZnU73yv+f0+NwOBwOh8PhcDgcDofjJwMnqDkcDofD4XA4HA6Hw+EAEdBs9M40m51HhkohvueRpClRqBjbODDQe/PSnRXTPeJLH52AJzwQEiv74s1fkz5VrVaRkt89fuzsFx6485biyPAYWzdXmVtqcubMGb7/vbd58IEDTE6OESddtO2h8FEiREgPX/pok7Lcmmd4tMw990yMfeM7U1+2afozQ6UqfmpzCUcoQGKsxmKxiDXxZD1rgooFKxU9FZBJibJ5tWLST1JTWIz0WFYTaIr4mYevGvzRl74SffqTvHDL/mqtG1+hIEr4vkIpCybrfzJISZ5mBbmIJFdLUXNhRr5HnFkVaW4SamSCp0B5IIjBCIxeYGikyP23PUL6pW+ycB1GRrv4kWL7thGmrszxZ3+ywtOfKjE2MUZrZQ6T5WJcGCiypIfOMgLPJ1ARM9MJJ08ss7AE994Pm7dUMKYNSLxAUYwKvPraFNcX4Jd/ZQLlt0lIEToiLGg27gn57NBG/uzfXOOFb5xn964qygtodRKiUpJLYGtpSeY969H/+T2SWC655K5MwYDRhqJtktkMU+xx8NE68f0DXD45w+yJFhcunCNYipisbEO2IpTxAA8tM3pBD0G27r3z+lbIBRuDJPfjVsf1o0lsEn0xEePl9aGmiMXDyAzdr/hU1hBqg29ygS2xGW3ZoeE1aYYNFkstCvtg+22DbNhUp5PO0S1fQkUptQA8CSEBiiDvn13/+bI/gH5q240UtdVnSKwVpFqQZZYshUwrlBri29+6RLsDn/65jZRHApZnLlEIfMJCCTI4fPd2ZmbPc/rkNNv2lLF0EZ6lUNDs3VujVlrhrTdg7tocD324QqU6QHUohDRheWEOqcD3QSkPLwhBDNBdUPzFVy9Rq8GO3SMkpokVlm4vYWITPPXxvZhkAamhsxKTdCEIFV6QVwzn0mVe4WuMwfbnQ8j3iKnrHxe5TGb7QlhqPbqmhxwZYP+2T/H1P/sajx/ez4G9m0AN0ejFnJi9zGuXZ9i/dQfVSp0s6WBMhl43/6uSliJD6SZZ2gNjyQjpigIvv32Mo+fav3z3I3e8euTtN0FotOxvPQvGKqwJUSmYZonZhTnGhweoFvnyXYe3bhjfUMAmMQZLoHw8JZAi/27tXoKRPilF5ts+56YtL37/4j8f3bz1Nzbf6tGRIV7Jx0roZunaWbgx9vcWef5V58LgBxweGq7UV1ZWKJR8lCfRqaHXzWi30jNYyfu6QR0Oh8PhcDgcDofD4XD8VOEENYfD4XA4HA6Hw+FwOH7asRIpIjq97K1eN0MKgcYgFRiTEAXgh3wM0TsiRQmdSnzl91/sY9bJRj8wiapfC/fE4/enr7/wvS/u2dz5h5vHSzSaiwwM1njk0Yd48Rt/ybGjJzl4+y1IZfKaPF+BDRBSgRchkfTabWrFMgPDPrcfqD319a88+8+e+sgn/isvEwjrY4VCYzFCYqRA42Mw6yrk8rGYdRV/2loS6ZFKD2VBS4NnDR4GBWg0XS/A2KCfx5RRHeW/ueW2DRu8oMFgrYjWFkSCNRotMpTQuZAEYKFWj/L5wUNIgULktZ5CYIzBWLsmza3KM3b1MeEhRIaQ5IlYskcvSSjIGmLmNNt3RXz/ez08QqToYEi4574KZ840ef75Nrfc0mawDqVySLVaxRqDxhKnXaavdLl0IWZ+FqoVOHw3jG2oEsddkjRDyQJhUOTMu1OcOAG/8LkAQ4PlxSbFkkBKy+LSNYKipFAe5rOf28czXz3Jm8ca3HGwTLlSYH5uifpAtCYKyr6gtt5XsSYXhH6Qw5K7Mh4SQYgkJCOVKzTSZbqhpLxPMrJzguaFHtePrXDp3GmqpVHCtIbUBUKjKKYQrKVmKRR5stpq6tZqLe3qtnifn/PvTF/GExn9jD+E9ZBGgsj3F+TpXbFn0KpHL+hwoXGBwrhi+NYqm7eOUNghaMpFGnKRsArCy9P3pADVT6SzxnyAA2TWWmbtTeczT3bTxkdrRZpK0sySZoLvv3iJYgkef2KUctlgu/PoDPyyZmV5GYmiUp/kqae280d/fJ6UFrv3RkRFRbvTxqQwPj5IvSY4dnSBr321ycbxJps3w8homXp1FCF1njqGornc48zp85w9DaOjsG//CMgOnpQsLM5z8Qrccw8Y0+Hq1BwbBxVxnO+X0PcRysOsq4+1N3/RD0xQy+mhTIIBUjwSITBxm142z/mr5yEqcuLyImMT4yStKV59+xhXlpc5eNvt7BwbpNNqrq2zlBKtM6RUCLuaJmmxaYzQMZkN6RifMycvcexs+3+475GHvhjVC/3rSr5G6arLZXJbTVrJWHkEYSK+8dXn/9m9h4c/tmPrIK2lWSLfo9vNUNJDiLxK1EhDJ4kZGBql3Wxy8tw03zgy+4Udt93yW41OD+V5tLodStEAmZWstNtrNaQ/DFKIPBlSGKo1PjY8UqdQLGJNgrWWLEuJe5p2y771wwmfrs7T4XA4HA6Hw+FwOByOn0ScoOZwOBwOh8PhcDgcDsdPO0IiVIAnCy8tLzURYpw0S/vpS4ZNW4bYsSv6XCu1XxC6QGYL5LWgAlAoBEr0+wl/8Afgex4hRRoN/vXiXPcfjg52CXxLq7NAmnX46Ec/wv/zpa9w/PhxDt15gDRJ6OkuURhQLFfJ4gyLpDJYZ7kxT7FQ5I4DOzDp9D9+5s+/cm6suul/01kAvk8mIVUZibUk2uY1myoCo8FqhBA3KxBSYWSAlh5gkaToft+iBaywpHYWawM8pUCs8KGHg39QrRUphz5S9JBhk1T3iBPIMpgYz+s6PS+X0GwW5xKb9MAoUmMwxrxPnLnpvgCp8jWgH4QlBSAsYQTGtrE2ZsOGAaS4xpl35th9m0RFhkCF7N0bUbjc4+wZKIYgZYxSc1gLqc5lJU/mKW8ffrjSl6i6dFoNvCAC44Gtcfada5x5Fz796YgNk4MsLkxTLPXrFIUhLBawRtBut1Aq5mc+uYWXXrjES99rMbahxf33babdWcICxWJIWI6wWZss6ZBm/XEobgh93Cw6WqvoUUIJL08Zsxk+mlpgEF6K51mCaJFwn0d5e5H5aynd2Q4zZxdYupAx0BzgtuJuir0SwoNMa7I0RRvTF6T6n20Fpj//8j2C06qxJj5oi/9ADFYaIMnn1oJAEliFNAqrBVKCVypwdnGKZtRiJZwlnEgZ/VhEeVJQHxWosIcKYsrKIDwF0mKkWd0iWL2qFul189bfd1bmgmdfcPQ9SV6cGhK3Ezq9jDRLyTKFkhHvnLrG1SnYtBUeemgUAk3cWUB6UK2B1pZiIcQYQ5pME1QUH/k4fPH3oRD22L5nDIHGmh6dbhM/KHLf/WPMzc8yfQ1ePQKFQovxsdZNl4tWG7SGHbtg565RVlrXsQmUiuNcOrvEYB02TQ6gsxbVGqRaUyyBsiqvktS9tXValT3XS2g/MJmQXLJSWkOS77lQZfheGxFkTA53ef65r3LLwXvQwSb+4sQiwco7DEaSTz76KJUoJLINjNW88sZbdHoJ9913X54m2e/uteRpiUEQ0GonRPVRzpyd46U3p597+KMf+i+bHUMtqCAz0AoS+l4aIIVG2g6BhiIJX3/m+f/woXvH//GencPEnQVCX6Dw1/aBMRmGJL9TLDCz0mJqapkjJ2f/xc67ar+VqBmCUkBmNWEhIkk7ZCKgUCjleppdrR6+MW+mX4+7qo7afsJguVSh1+vRaDSoF2Bg1P/s+OQwvW4XrVNKVYUSgoX5Jtem+N6/vXTm5DSHw+FwOBwOh8PhcDh+UlFf+MIXftxjcDgcDofD4XA4HA6Hw/HjxCacPf59JgaD63OXTnx+1/bJmrYWIfNMISMs15bmhl95s/HlseENM0lP4XkewloEAmEt7W77A99eoNl3y066zTZ7tm28PHXxwn8yubFcCiKNVRYhDJ6QHDywlxMnzrG4OM/WbdvpJRmtThOpPKQv0WQIP8MKw9LCMuVShXq1TpYknzhxYuaNweHhMwvNNhRD4qBH10vpeqClRRiBWvMubraMMhHQyAIMIRKNJEWKHh66n04FO3aOUohSmosXOHXs1KZiqP9JwV9G2gxrYvwAfF9SqQTU6h7lSgWJJU4yul1LGK4KHhZjs35KWn+OxY2bEPam+6tjXRWjVvUaIfIErtzn8NmxdTMvvjhPULCMjRWAXFipVkNGRzyUl+H7+btpAwN1GBqSTE7W2by5SqHoISVIofqpYiE6U7z15jxXr8BHPjLGyFiFXm8hrwhNBdZIrE2waMqlKp7nobwUQ8b2XdsYH/W5dLnFqdMrGJNQKhUIoxIryw263S5IKJYCgkiSWZN/uX6Kml33XQ0elhCBQJm+sCczrMrQnkYG4HkZ1svQhZRwUFEeLTAwWaEwoIjTJotz83SyLh26WN9ihcQagdI+wqp+HeyNvfGB1at/3Vm6CQvC9sU0nSeYCcikoZE2CQY8dNjmSnqB9lCb6oEC2x4eZsv9dYpbU6KRHl6lgx/F+ErjK4sUFivs6lTlVbFW5eO1Yq069ibbD4OQFmsgiS1pbEi6gjiWCCLCqMalqQVefrWF9OGue8oceHAzNlmktbJCsajIUosxedKdsR7GQqZTEpNRqlTYvWOA736/TbvdZnxDnSCKkEJitCbNYqLIZ3jYZ+euCqOjPu1OnCfAyVzSm5yssWVLleFRn2Z7kXq9gKeKXDy/xPHjlseerBAVE9rdJn6Q175KC7JfUWqlzuda9LVSu9qtmt/y5bN5CqHQN503JUUujkoBEjJrCYtlRkcm2bNnC3NLbW69/yneOv4ui9cv8+EH72O0Nkx7cZFKUdJqr/DOuWlu27+PUqmE53mYdVWfVlhMlqDxOXVlgddPTV2YWuDezVvHbeT56DTl/MVrZPjEwieRCq0Utp8IF1jN1Kkznziwu/p/b986QDmSoBOk8JBESJFXuxpr8vONIChWuL7c45vffufPn/7cU796aeECmUoxsm+hIRFGIq3ACsHswgxWgLHmPbs8v26GVvTlx/x3Ruepj+VymbTTPXTngcnf3LZpBCUUhWKEsQkL88scP3bxykOPPfVf77zvaRClm9537YzkK/NXniTXDupwOBwOh8PhcDgcDsfffZyg5nA4HA6Hw+FwOBwOx089MVfffYOC6PDO62/u2rG5eldQDIEMRQbKIqsBC0vzFWWG/iTyhvJUslWEpdNpoYQlL6W7+SaEYWxkmHq1hm99rpw/c2BoSB6sDfh4vsDKDGM1hUKRsdFxTp26BPj4UYgXWlLTyUWWQORlnTKg1WojgHIxZGh4gE7a+cVj56a/NThZvdRSLeLiCp2oTcfP0MLgZwZP9+Wv96RgaUK6SQTWx7Mpnk3x6eFZjQ/4Fi6fmi7PXZr6RCQa/8Xurfz2xiGqAK1GyrXZjMZyxsKcZmkxY3EuI1QeOvMI/TKlUoQ1GUJapJR5uhPkMtZ7zIv3V0sKsBJhPUAhCAAPgURIDyElWAgnJ9i72eObz68gyagPVPLKStVDeppS2ac+VGJiU43JLRVqAxHFko/yDUnapddJ0bFC2jK+rHD23HVOnY4REn7+szspDxVYWZ4hSXpEUYHAq+P7QS5PBXklqzEaYwyZiWm2ZhkcKbD7zi0sz89z+RJcm05oNFqUKxFeGACWOEnpxgZtQfe9IrO6RDYXsAQSZQ2KFCkSkClWpWTKoPubTKkAJX1CG1HQAb7RCN1kYrLIzkMb8Tb7NGotLnWnmO9dxxMBBVHCT4r42sOKDNSNPf3BgprkxgZ6r8zz/rUTFqRVeNoHFImStMOM6+o6F8RZ5odmkPvb7P3ZUYZu11QnY/AWKRVSCn5KQVqUzH0zLfMbIq8EFf39snrO8inLUw3XhMbVGlmtSWLotKHdhG7bIkyRa1dXeO31FlcXYfcB+PDjI1Trhri5QK/To+CHWCPwQg8v8FB+hB+EBGEV5dWQVBGyhBdIDt21gYuXFjhxskOadREYypUyXiCRnkB4FktGN2kxNl5icChgYNhnYDjADy2pbgFdqvUSJi1z6vgir79m+bmf38b4thq+6pLpGN+jP68g8/xGpLDIvoAmVsVAydrNivwx+gmEa4afsGghUNUBkB49bWhniqtXU46fmCXLMq5fn+drX32OKCqRmpCr0/Ns37KBwNNcnZrmhe8cZ8u2MXbt2kOc9HJJzFpsX0i0AmQYstizfPfNC/G5Ke745KcfX5HGYrorlKOIdy9cJxElUhmSygArQrA+yviEOvnQSGSfe+JDWxGih5Qir/MlQooIhcqtUwxWaLQUTC82ee4vT5157KMffTCTETPzs/nuNT7CKDwLyho8a5FkTC/Oka3OUX8nraqiCktgJJ7pzyMWrXN5ttdNGB7wf+eBu3bsHx4oIqRHoVTE2JheL+Hto1f+YOOWQ89su+cpEMWbr2trn7NeUPvBZ8oJag6Hw+FwOBwOh8PhcPzdx1V8OhwOh8PhcDgcDofD4SDJNL1OQrvH/3Xh8sx/fNtQLjihfIyF8dERJseu/tIf/t7p3/jMz43NtVoZRhgQN/79AXYVkDsPWZYxc+06Q6U6C23z/PWV3i8PxWUi3yCVoNVsIEVAqTrEbQcP8vprR9m1ewfbdo3QbC3QyzoEMkB6PtZaBuobSdMO3c4ShUKFpz5+CO1978U3T1x9cMPO6kuZSMjlBx8jDKmXIo3AWosQFmMt0q5qPQZlZC6MyQxfdFAkuZxm2KUE/9HtB/mVTePB0MiGEE8ahJWUy0WCUKOkZmmpQZZqkjSvXDx/roUFMp0LVzu2Q7ksKZYilDQYnQDm/Z2RIk+pukFubfWLJ8mrVWWetGZBWIuUFuYvUhoe42c/uZUXvn2Rd88vcftdMD5RRKORIkIbSbMXY7UljmMCP6JUKlEsRMjMY3mhyZWpJRYXY7IM7jw4wNa9W5i9eo5er43yJEEYsLKQkMbLGJvkUpcAYWOkB74XYK2mXC2DFKSNFe579BBp0+PqlRnOvHuZo2+3qNWhVpcM1CpEBQ9DgiTDiDwlTMp+wpwQSNvfX4AVBkNeg2gEKPpBc8Lm+p6UCAXaN1SGA1K7zNzKHNUDw6iJgPFbx2mfz5h5Y5q00aMejOLFAcIafATKSJSR/RrYXPqBvLXRrmlgsr92BshuPGa9dc9ZW05SZWiHCbGX0A0TOmGLFe8aI3sKTOwboDCu0eUZrJfgCUWhqFA2Q2Ix5CKWFv1BiHw8q1WectXkE3mynMk8lPL7G8kDKzFCEicZnV5Gqx3T66YszGnieJliAW65rcyO2yeRYY+lxSkiTxJ5ZZaai+hQ0el28xQwAUbEfXGwg/AK6NRHZ020bDM6OsoDD+ziwrmrHD3apd3MSPUymzZtxPN84rhLomOKBUWWZUipAYOwEMcZlUqZTqvF28faXDzXplyET316K2OjNRqLF6gOKerlOllzmSxbbdFUiL7paW3f3kOvCYamL4qJvui5mh5Gf3UFeVXtpXPztDuw0oR2CwoB1EoK0kXGhwMO7Q3Zsnsrs80Su3du5Q+/9DtsG/LoLmU88ti9jI6OkumUODPoLCMIgvy6CIDHcqPFcy+eYHqJD33sEw9eXWn3kEZTLCga3RaaAEwRaQy+zVAyJTAJRZ08EBnz4lMf3UcUGkQa5LWtIkDKIB+/yWU8aSTaBhgb8cYbr+vZJR5LRYC3+t42yIejBdJKjBXIftJbkOUi3+r1cO1fK/tnoi8Fkp8741k8ARcvxqN3f2Lj58qlEGs1EsX87HWiguTsuxdpdvjXKqzww1V3mh/y+Q6Hw+FwOBwOh8PhcDj+LiCstX/9sxwOh8PhcDgcDofD4XD8BNPgS//zP0E0zrOlYjjx6jNnPvLkrbvCokdY2Eg3SenFyzQbMc8/f/L/OHj7o/+BVUWSzKAKgqgQ/H/svXmQXMdhp/ll5nuv7uquvnERJ3EQJEESIgnxEHiJpERZsiRL9tratdcT49jdsDX2jmM29o9Zy97YccxMjMcbMbte27Frai17LMmyRFm0JergAZIiKZLiAZAgCIA4G313V3Ud78rM/eO96m6AID0jey2NlF9Es7qOfpUvM18R0fjw+/HYo08ShvE7HN9w+6230utGlKsV/vbhh66+/b2bX715/xZMfAEddymVGwh8CoUCghLHj87xwguvcO/9NyNUDy16+L6Hr2oIfKw2JLqD1R0EEaVCgWbL8L1XLvDGmfDOOx64/7EkKGeVedaw3JrCpBEmNRBrRgaHScIErUHKIVK9njCJKVdb1Gttvvblh4uDFf63K9bzGzffuFU0hjRStJHKZElx0s/qARUgUjqdJpVKQL1exSuXIerRajaZnU1pNWF+DjAwMAgTE4JNWzeC0DQXpwkCibZJJplcJlUNsqQoJTykUitpXplsl9cTihJQAmpAwJNPP89CE5a6MDEBfgDr148yMjxBEibMzzcJezHdTo+oF2J6hu4yLCxCexmuviZPLRKrqWYmDzfS/aCxNeO0NtNKjIY4hZGRTGTJVh+kgtGRMayQzM4scuqtCJWfr6dgqAEjIwXqdR9JSLFsqJQF1VqA70uiTrRGKOwflRUJSMhMQJKW1dflMltqDVGs0THYsIJulwiSEc6+scTRl6fQU1BrDrO9vI0xOYBZTrPkP1IQMVYYUuWjhVzxCWX+nFHd7PwJwBTRIsAgqVUH6HXb6KhLrxxysnyBzkATUYwZ3gg3H9xB6i2jVYxWIeW6BBGvaDnCXlzxahEr85m/YPVbkclFRoNJIOqBokYUCjrthE4oOTefsNxLabcN3RCGBqE+ACMjZaqDZaan50g0JCEUAghb+T60gMyXWq6utTWAAp1m9z0fVC4NYsHz4ORJWFyCjRtgsA6lkmJgsEKlFFAfKOH7gm6vw9LiPK0lSBLodsGXsHt3mfXjGyiODhC3prCqCyJGCIsnwcQp0koECmuzZERrDELmVcBCYvump5VEUYSnihRKNURhANvTzMwuceL4Iu0WFCvQGIbhBvgejI5twKaQppp2N0JT5PiUx8nmViq1BvHCd5k/PsOe8VEO3noP8wvz2X40hna7jedJwjTEaM2Z8xd468zMiddP8KkD79vyjKZMY+RKemFIYqfR1qdWvYbmEjRqZUTahu4M/88f/M0dH3q/evT+u27Gmg5KaIy1KOmD8pBCYYzK6j51B+kFqOIIh557nSNvzXxiZMPWv/Trg3SjkBNHX1/zWbIq5gkJVgqMEqutsPYSydJKDt5654ogmUhIfY8oWuClxx/7vz/18Rt/uVEMKCAZrY0yNzeHCCx/9oVDx/bf9qFdM71RPvbrvwdikLexsqfNmv++HemENYfD4XD8CFKr1d71+bWV35ej2+3+Qw7H4XA4HA6H40cel6DmcDgcDofD4XA4HA7HTzySJE6plKq0wkWmluy/Wlzu/smeTdtZWLZYAqSG7ZvWc+7KmX/yrW9887c//LGPnC2KAK9skVKASLNUr8sd3QrKxQqpgV6a4pWD482uaXYjMRCYTDIxOksCi6IehSDgqquu4ty5KY6/eYbr9++g2e1hTIoGPCWRUuKLElqEmBRs2GOkUuHGq7cCZx/9yp99/ad/6mc//FC1WGK2u4S2ISpIKRQDfFHA6gghNR4CbEi9pCkHhshM8sRjhw7s389fXHXl2OYNoxMIEWKZR4gu1oLWFg2YvgAjLEEBpBdjbAfSlDDsUq74bB+pgSpDt8jc9BLT0/NMTolCytcAACAASURBVFoWF88yMVFmbPtuiFrYdInUhOhUIxCZcLUGT/hIpUDKzAgCRN8YsxKMBWKQy1g8bnvgALOnzrHQahHGmuVWxOFXZpmbm6XoZbKZUlAogK+g6sPQCGza7FMsBah+jWUugDWGBlZqXY1JuVglkdjcntLGEieGVns5e63IRLowhbm5GQzgKcHmTQHLbc3Soqa5CMePQaMRsX1bxPZtAVGoUdIgVUy5HGCRaLHqs/QlNGVWRpCPyaxUYPbxVVaTmShIZQcZJERRyoZbBmjs28zcG13OPLrA8cnXuNCrs21oO4VQECTgWZOtNRKDhxQmk8f659aPnTJelliGhxEwuzxHcUAR1bqciY4Tro9o7Cmw7coJRic8Yi6AiFFS4kmL0TFC6szkI0uKyxdgzXX09mvLXCIzmlwejOOUubkeZ0/D1AxMLkGpBoMNGBvLbrWFuWaX6cUuvg/lAgxUQccwMeIjRCYtZSl2ZHWykF17vo/neWitSZKEOI4xa7pzpeexboOm045ZWACTQq+j6Sy30AbSFLq9TFCs12DTxsyFu+IKxdbNmwjqZeKlBfRyi6BWIO4YbF74atN+tWe/ejWvoxT9VLQAicCQpadl9p5Hcf120Iap4yeZnevSboPvw96rS4xPlPF8k5mc1oLuYUxMmsZ4MiWNFtm2YYzvH3+Wl1+O+KX/6gM8NfMNUlnh3LkpjEyZnjnD1NQk8wsJ9Tqcm2RpbpY/lD4vtNp86baDe0xiY4JywGJzjsikmCAmKBQJkzblQgXftKh6IYee/psP/8JHBh66ad8WbDiPKhTQVuFJhZQShMBYizEp1mjS1OArn6NHTvHMM5OfvXLfrr+sDY/TSrNJFiK4SPDMql8tIt9USq+9ni/+y/RMXDNZaiGAMLSb0zz52FNXvG9f6Zc3jNbptHoMNoZZnJsDJJPnFlju8rud1JAKJ5c5HA6Hw+FwOBwOh8PhcIKaw+FwOBwOh8PhcDgcDqBYqZC0Z7F+wD0fvOfBp1/41r8Z3bhx1PMHSZIQITwWFma5YssIQ0enP2utvqtYqpEkTeaaU0iyZLHLImBq8gJ+oURhoML+/fvD6XOvHev1ejdKL6WgFNoYDBqpFGGUQBBy59138rW/+SvOnKswMhqg0wS8BIQHUmQVf7KAtFlyVBhJavUS+/ZtpZ0c+8qXv/DVX/noJz/8x0WbkJKS6hDda2NSOPzam97u7TvTWm2QpcVzDK2v00rm+eyDh+745Cd59Pbb1xH2mvSScwSeQqmsklMCFovIyxz7glC5oJBSYBJLpCOEECRJTBRFWNvC9wJGxiuMrN8IWnDizbOcPNFlbuYI4xMjDI2U8b0AvyAye2dl7voGUl+GU9n3Nq/BExarNVYbNAlWdjAipXnqBGPjmxjdspOp0zMszp4hjcCTUKtlklKxVGCwXqJcLKDjCCk1SkqkEniSXAEyuQQUrchqmaC2ZkxITC7NGW3xtaZa91eS3iClXJEstRKwMFivEvUEqVEkqUJriKIenU4nS2BLYoIgk610DLGweF6elPWOGUvvgLBYm01jEEDgK+JIU6yktJcvUBsqs+H2cXZdOcbhZyZ58/A0c/M9dhW3MCoLiCSrOdQiQAuJXCvn2QBtMzHNSwOk9UBIUi9mLplioT2J3BQzsAP2HdiEV08pVy1xOkehkF8Y+VcmCsn/7POTNjvCypWXT3mc9CiVYfNWWLcR3jc0iPQlyrNImWCIkCpB5MlnINFWYK3IksjQWQrZWkEtv76ltPi+xPMlOtWkOqvStWtkuU6nQ7VeQ2ufXi9EihJpaOh2e8SRJY5hZgZaTYjjbAw7rryC2royhEu0589QrhQRwidudUDl6XX5ewgh8utwZSbWzgJCSFRfVLQBlcowU69NMTc/Q5wnGe66aoRgqIxdbhJ3u6SphU4Xay39xgmlFOWShzIxVsywbwvc8d79HH1tiWuu/W8QSzN88/HH2bi5SqMhqAwl+LUshe7CAhw+yv/56U/vPRNGI2g8pFxEFCSPffcpb8+129Px0RF67Qi/2CNqz9OxTR75zvP/9Margz+69ppNqAA8USK1Fk+qbKJW5DSN1bms6pfRssRTzz4/c/N7r/mlUBWJwgQtUjyZCb3SypXPq+zaNNi8Gnblo1tcfv+lKkULD02AImbAdLmixIM3XXU1ZVHGBj7S8+nZhDi2PPXC0ZmPfuJnH5wPQYjKf8aOXv1MufzjvMPzDofD4XA4HA6Hw+FwOH7UcYKaw+FwOBwOh8PhcDgcjjxBrcJSe4lOuMwbp/n0U8+99h9vv/U2kjhkqF6ls7zI+g0Ndu0ZuPOhv/7ax++97/1fGhquMlCrI22eXsXlkp4kxWIR5fskSUqxWKTX670Rx/GNZWkRnkXm6TzWKBCSVmuBdeuu4Oq9e3n2uZe4/wPXAhptUqSMs3o/aZHCA6kQUmFSTRrFDFaL3HnbdVQrb/7Rtx/+6o4Pfvj+/0lEiqV2j/mZWb/T7Dy1caS88eTrx56KuhwultHPP/3q54ZHmf7Fn+fb+94zSrt9gVIRVCAxSQo2xJNZgJnwBJ6UWQqRAqkknpIIkYktaaIzqUdIPC97vNvtERQkQkiSxLB9z062b4MTx09z/vwc2gZUagGVWiXrS7T9STSXvTXaYGyWOqctWKGzZDebYgWMNMY5cew0J948zcJ8Jszs2VFg06YNtLtLIGI8DwqBBtpQSJEIfN9HSokSFmtWU9TW1oquVCeukK4IPdpAkKQIIVBK5T+vsWgafU9FL+Pl1aFCQCqhPBgwMV7LKhI7HQKZSVvWiCz5yYAgs7EulyT2n4TNpJygIOmGbSo1hbVN5peXqIyMcdV9Y2y8aRtvfW+K+VfPkbbKDCUlgrgAxCjrIYXGYlZqEIXxwEqskCQyJfZDOqUlFvQpRq+vsv7mcYa2KMJoEryYWIPyxZqqVo21mWJm7Q96YqvbReTOW7EMxZKP1T7WWio1QZp2CcOQJIKREbkSvqchOyfI6mLzXxfKfM37a99P9bPGYm2MFClGaDyVVc0quSoN1cbrWKtJdYpJNEq1sZ6gXFHoVGK0YMf2QYwWLC93efGFFmfPnWGgkdW97r2qThT1wGqCoAiAXjM/1tpMiswf68/dZWfQSk6cOEGvm1BvFNm8dT34CXGvSXduHl95uWSXVcSmaYoxBs9TCOFhgaACypfcfF2Z5WiZ4wQ89Fd/yj3X7+SWAztIVYfGiMeuwSqd3hILc012790yuGXL2eOPfudIPe0wUSzzqZ5FNSa4+pory7cuTJ8415k/d+vEyKakUYvQtR6Pfev5f33NVfyLO+/ch4hjMIKFuSaNwcYlyWkGnYusVvgEhRrPPv86k7P8zGYtCOOU1NPg24uqePtkQqlFvoOQdtlpFAYjUgId89S3vv8zH7l7452DhSJL802GRiZYboeUBhpMLk5xZir+Z0tdiNIUiuYdxTeHw+FwOH6M2QJcl3/1+Qrw0g9lNA6Hw+FwOBw/Aoi/zy+/HA6Hw+FwOBwOh8PhcPw40OZz/8dn8MUCUjbxaRPYLt99/MkXfvYjt98wMVyBpI0kRkuDpszjTx2NnnhiZvgjH7q5Ux8Y5tuPHiLpp/lcRlC7ft/NeKUSoU3B9njmyUf/5w/es/tfXbneQ5gueEUMAcKWkBQoFoukqWB0dJz/+OefY2DA46ab9xFGbeI4plQqI5VEGg+0QqZ+Lq30iImpDjbQIuD4W3N869GXvj7X4qc/8rED0YsvPPPoVTs337F5/SBFzzI7cxZkwJvHZtonTtuzn/jU2J7qcEovWcAvgRQF4l5EEkK5CPUqFIvFSySpVfnCWrsmOUyu+T5/RPoI4aOEhxBqJRHtwoXzWAuVis/A8DBhu539gLi8oKa8TP4yJsUg0QiKpQE8v8Ebh0/zxus9bAojI7Bt6yhWdPCClCDw8AMBIsaSrIwrS0vL6lZh1WnpJy1dxCWySb/6sy+cZXWQ/Z9fc+79ObMyk7JsJkJpbFaXaWxWR7hSRZhLgCZPeZKrY5FvS3y6ROC7jJSzOn67ekYCTCrQcRkTF1Dag7TG2Tc7nHpxntbhhA3xKLtLmymlBbqxxiBZXm5Tr1QIpKQTxZSGhjnZOsl8+RRic8y1D2xGNzpQSYnSJdaNZXWWZF7Q2/aF7ceP9c/97xR61u65bJ6NyatbpUDig/WQQrGazNYXhQzYrLgUmc29ETJ7b6ny9cmv5UvG2a/5tOY/QTgSl7wnYI3AGoU1CmN8jFVgPXq9lF6YcPp0m9lZSCJ438Ey67eMkYRNWq0lhLQEQYDneSghscZkt/3KVWNXUtwK5RIISXu5xexMzMTEAFiJ8ARCZAmBQlqEyGQvqw1G25WOVJtLYEopjBJoz6LRKGuwpkonnuCpR4/ywIFNkMZMd8CrFFFBh+X2Ir5XwRejdJo1HvqLl17ftY5NW6+YqGqZkgrNtl1XcvrCHE88cfLRnbu23fWtb50sjI3xlWuuLtx/83uuhSQh6YUkPYuSBXy/gBACIwzWWnSakmqNFWBlkfMzXR479NrnNm/d/V9rilgVYKRByxghLW8ePcnbP48MiCwRUKHWrNnFWCQ33nYb+B5ozd988ZHqXVczd99tNxXwCjRGJ2h1YyKgaxL+3z//mxduu+3j70kpgkiJafDAP/ldYPCS/cEaeS5fw3dIUHt7XppLUHM4HA7HD59arfZOT30G+C1z+T8v/Xb+PN1u9/+PYTkcDofD4XD8yOIS1BwOh8PhcDgcDofD4fiJRwL9FKi8zlALZpt88nsvfv/4R++/NUsRE/1ayZRrr99SmJyc+epgrXq37xcxxmDyKkArLiepgTAWJRQaydwshxcXFhAbJuj1QopVDyELSOsDkjgJUSqAYoW7776XQ098g5mZOSo1D6k0xvYQtggESOEjVIA0FiVAaEF3cRGhJOODgp/+wNX3P/fia0efP/TMwv79V9ywZeMYRWkQpsf1e66kubTMFSPrqpvWvbnn+8/McPs944wMrWNxeZZIRwzWy9QmQNk0Pw+dpU9d5h/9CQEXdR2uzO/q99ZqNCnY1ZSqiXUNut0eYRgyc2GKer2YzaHtH+7iv+Dq/4VXluclqA5NkPYEhx47yukTMD4Ku/aOM9Qos9y6QG0AgmJWc2ltmkk9a2UVY/OjrT2n/riz91q7pivnLlZ/YqWBUbIinqyc+dumqi/HgLA6K2gU+Y/lBxEWJAoj+0f6B/pHlpdsUKkkogipF2OjJtZbor6jyP4tV9C8yvLmN0/y2vlZxs04ZTWKMEUKhRIxKaGMCGs9Xpp5lfIWyfZbBtl40yCdyhSi0sULFDXPA5NmUWWX0h+H7Vd8/oCnlB9GyuyYVqQIm+YCJG8X3+zFIpDsi3MGwKwKapfEbwlzcWLZRWO4dNtf9BKJsAZryfY+Fik0wgqM8CgEkKaa3btG2b3T4+TxC3zjb7vs2HmKW2/fyPDWYeKZSaIkIQgC4l6IEILUaoRdM57+e/oBnYUFwm7MYAMQ4crmsngYoxC2nwpIvwv0ouHLvoxnLVqDlRaJQdBmsDDLxx4Yh84FkGWGylWWul2ibpvALyNFibBreOrJl7j26oE9N20fp2A1fqlGq9umNz/FoIKb9o7f+fKrJ1/Ys5XGzl3FrVs3b6I9Pw9aIGWA8gr4KsjEUdtPjssSCw0WpKTVC/ne4WOdC4v80+3XDJHGoLXGWItFY43B2hSsf8kWswjRFwjF6h65DCbV6F6XkZpHw+eh/fv2FIxMqdWHmF2cw+Lh1xp855Fn+dYhPnnjQQ9rJcpKnEzmcDgcjp8wHgR+8V2e/y2yFLWv/KOMxuFwOBwOh+NHCCeoORwOh8PhcDgcDofD4QAkBkkifaRIaTdjfu7nP37iiw9+6Vd3bnr1P+zZMUGWvFQFoDaoueGmjXf95Re+/Vu/8PM/99vaCqwAnUtGuSdzMVYCCmzAxATfW1po2jBsCCktqU6QJGAFEkmShkipiJtNhhrDjIyM8tqRE9x9734WFqZBGKT0wWbjlsKAlEhbQAqBZw1J2MJTEfWy5eAtG7YI5W8JCiWE7kEqmDwzTbKoqZbLtNtNrtpyJTMXXuK5x6e5+fadFIoeUjWBlFLgI4RFGIvRBqst2uQ1g5fSF3UsmQRmoS9p2FxyM0aDMLmzZPDxKBUFpWKBVitCEJM3KmbVp+JiyaPvOkkLxgZMnk54/nvnmZ+Fu+8o43sJBTWL8hTrNgZZYpa1kCQIPLAl+mIiwoDsABojVlOoWCOhZbJY/2GbC3rZOZo1UyBWzjsfu1hzf0WS6qtAZmWa3j59BilA5LfZoLx3lWjejdVEtTwprH8ck4mZWkiEb/A8CUlKLW2h6TC4t8oNG9Zz9OuTnDs2zfhyQCWWVKsNRENykhleXjjNxEHYets6Nmwr0YpPkoiUQEGlkuIXCnQXs3WXxmPF4JPRaoqU4aJzu/TaeZv8tXa+xJqlWpNIZSWYFSGtf1X27+YVpStvTrYPhM0kU95BUMvv28vIgpfPVJOQn7O0mZxprcWSYNFoCZKI6lgdudihG4YoEXDglq1s3rzId59e4itfPMe9D9QpVwOMgDRJ8/W0/XdAmkvG0wsxSYqvoFj0sTZLC7RWgdUk5uL5UPl5rW79PAlRGJQFP81ELqMM0oLnadAahsfpLXcoFAMKxqA7ZXxZp92Cp598i8BX7NmzB2nahO0ep87OYT3JyIYSnajJ3quvYP2Gyg1htEi1XEHHljhUBH6VwC/j+1manbBg0SuTnOpMkhVCcOTYG1xYTH/55rtuCts9SxRppFTZJhIJa1PsbD8prX+yAt5la62sckBApaj47kPf/Je/8olr7xpbP4JGY0oCHScM1Gq89Npxnnlh6lc//ZsfPBkrEMYgzOr6v+sbORwOh8Px48EdvLuc1uc6nKDmcDgcDofjJxD1mc985oc9BofD4XA4HA6Hw+FwOBw/VDTf/94zgCCVCmNLQJUkVVx91cbvvfHaa9ddtWPrbmUF1mbVcaiQkaFhSrJ0x6Gnv7eYqPRZIy1aeBhUJqspTaI0Rgg2jG9CyRKJ8LAYNk2MtFsL5z+xbigYa9SLWGGxRiJNERBIYbAmob3cIol7VKoVmguLzM0ssHXLduKwi5QSKTykVIgVC0qghKBWLRNGXWLdplD0iJMelXKRMAxReAxUGpw+foY3Xp9i08YNWKNRwmNiwwbmm4s89ew0iWmRphFnTiVMnY+Ym05ZXk7pdTXlYgBWAYpVy2NtlpjNBZL+sPIUMgHGJIDNZZ0UjMGSkuqEMNJICUpk9YNgsWLtcXNBSBiwCqErGFvjLz5/nqEheN9tYxi7TLViUcLgKYMnkkxWMTYbs/XIZC+VpSoBCJ3VbAqBEQKLymWkvPrTSiyXfllsPvOQS1K5hCJEJoWtTUQzUmKFyN4DgZWZDGdyYcsKu6IM9Z00sfaBlcrIPOpLmJU5MYh8LDI7Zv4+dq1w15fTVm5X18+KLNFNiASlLMWhEp6IaYsIHbTZvncLnWSZ2ZklWmELMVDkpdlXma7PsfEOwY0f2QojTbQ/T7GmKVUg8PJpjzXC9IW+AGFVXrWoL5YZ1whT4hIBTFz0ZbLbtXKRFXl1aH5X5ofMZUArxKpsdlGF6kUTvFZfytdRvOt9IN83q8O4aLAIEGrN/slO1giTSW4CjITmUkSpBOWKwKBpLS2hpM+mDQM0212+/1LE+HjE4PAIC4uLBF6QH9uC1UgrMqkvH0dnuUO1UqFYCojCECUFSIMUFm10du2RYsmuv/4cCMRF9aaZLivwDFn1rPAR1kdGKXOTbd46u8zkXMip80vMzrVZnO/RbUke+eoFdmwqcP2+fcThMgpBIahx6KmjlOolivWAQrmQJcrpFCUsYS8BW6BeG6NcHMRKCULmyYK5SKiT7PNCG4TyWO6lfO+lqcd2Xrf3Xxi/jBcU6PTaCKmBOBPURMrC4mJ2pUgDQudfafYZIwxaCrSCREEqJCavfpVWogxcvW0Lzz/2yK8duGbo31x/7Q4WW00aow3SqIsfFDg3tcDn/+r5r9xx713/vNYYJzUJCI0yAk2JXfvvBgpv2ztrNnD+X3vpE5e5d/lHHA6Hw+H4x+Z3f/d3L33o94Hd/Tv5nymawLNAAyjm9/87YClJkn+UcTocDofD4XD8qCAuF8nvcDgcDofD4XA4HA6H4ycJA8RAmn9v1jweQjrDH//yna999P7r9pRHi8y2ZyjXFUqU6CwFvHH8HH/wZ0f/+T/7zft/T6cNupElkl1SFWJlD18HTL40g0rLxDIAEYOeI5w/8XsfuG3dbww3BLLgkeKjRANJESGylCUhI0BSLa/j+OtnOfbGWa7ddyVD45bFpXP4vs/AwDA2LdEPiu9X/nkFSS9sEUURXhCw0FyitdBiy5ZtlLwiUZTwysuH6XW6fOCuu+iEbZJA0bIxjzz9AtU63HStYGhQESeabs/SbkK3k4lTgQ/FKhSKsGvfOMTLdMIeUWSpFC9WfaxcFSqMyVKYrF3Vu+RF9Zl5oFb+mFnjYvQTkEplhTe0hZPPzPHoYwvsuhZ27BxmoOJjdA9PpUiToITORZvMIkoTgzUCKbNUI2MM2hq0LzCeXRmHNSIT2oTB5gJP/3dIxpgsTG9tctoaMW01Qi+vnFyzo6RYnRelFEEQoJRPe7mN8hSBp/B8mQk0JiKNNDqPi5MK1CW/xsoS2hTa+HkqmMEIgxL9ZLBLc73kJbes/AzCIMnSqgKVeVxhDJ02FJAU9RjdqQJf/8vTnD4OjXVw50cbbLiqTM/M4fkJypN4MjvWRb9yk4D1MsnJSpSwrK05XZHmcpExWwdzUUKfvIy7IyRoC5I8TVBk1ZTSV2AtaRznaWAKjCVNEnSeNibXpPL1xTMjsnW2xq6st1QS6XlYa+nFCUZn6yz77aFrxyNWxwX99RcrY5dSIaUlc68yCdNKi7GgU0hT8JQAG5DEgjgCbSRnznR54ygcvBM2b99Mc2GBQkFRKEGn1cLXmUTZx66MI5tnK1f6S7NdsUZmw4KyAiGyObR29dwLQQmpfIgVc7PznJtMCXsQh1CtQLEG2gdVhcGhYRYnB3nu8RMMWDj43p2kfoJfqtFrKZ558vtYCe9//+2cmTzF0FCD5lKHOErxfMXQ0BC+9NGpwPMCkJksJxFZDW4aI5MuVhu6cQKlGl9/4nmmWkxUNoxMJyK7pj3lIZWENSKe0RJMJsVevOYSLWDzrh3ESpKIgERbRBxTNIKKKTNAwmNf/s5vfPDukd+7fv+1NFtzDI2OEIVtykJzYTHkD7505GhPsCcVEi08bH+PAZEd4Q//8jCIId4Jc9H/c/o/ucrbcxNdbajD4XA4fvjUarVLH7roT6rGmJfJUtWWfpDjd7vdH2hcfcrl8t/r5/++7+/4L5vL/cOUtZRKpXd93u0fh8PhcFwOV/HpcDgcDofD4XA4HA7HTzyS7B/0vwMi4NxS9X3fefr4sYP3X9uolKuQREihGah67Nw5wX//P8T/7q8e+nrlZz76yf+1tbSEqkPqRRiZApJEpRibooUHQuJ5FV5+nc9u3Tj1G3dtuJpEdwiMQmKyhCjZT0fKBB7da3LNnt3MnGtz8s1J6gPrCLwCQmhMmqBEEWNzkUqACgpEcYzn12k0aiwtt5gYHeDZJ59gcKDN2Pb1xAsL7L3uWp777jM8+uQTNEbH2HXDdYhem/ffdZAnnnick8ctez60GYoFCCOiXo8oikiTlG6vS3M5obkEh1+YplSG6gBUKqzIMKtzKFaSqzJhLHvNReFo+ctQAl8IhFBZilIfK3MJS+IFNSZfPcfjj3a5aq/P9p1VUrPAckcwMjQEWpAmkKQSKT0ECqshTRISo+l0evieolAoYL0CcSrQicjFuVxWWlObuPYfOFq7Kqz1JRchsl8xKSmzZCY0Go3IRSdrLRqTSVQatDEoKfF8gUIjTYCKLdqXyBiktaTGZOFWNhOevHxtxRqxCJsVF/Yxor+fLe8usawRYnIxbeX8BEQGlIRCITtUq21I/AWKW67A3wNj4/C+g5sZGF2mo89TCMDzQHmZoSeMzCWdvNoVsSpyCcOKxWeDlTGsJMSxKiWKfP1VP9tMSLB9AU7n6wDaWrTN94iRkArS1BLHYo2QmAlg1tpMYssNM2sNWB8NK4lqUgisFNn6ajDaorUhzSs6s9PIn18j2imVJZnJ/ARE30wz/VSytVajQfVbX6VFCIlUklTnkp4PRV+iE8m2rcMYPc83/hY++vEFRseHOH3qNCMTZVAeQRDk8l8/Ic1iTMrlkCvpbvmtBWHtmmswE8OSJKHTiUkTOHcafC9b40YD1q8folQq4dVqQEhLL4A3yHe+/ha+9Lnlhh2YNCTSCecunOX0qSVi4MYb99FNErbvuIojR45w4vg5PvCB+9Gpxg8Cws4yRqQkJsETipUK3v60mWw9h4cneOHwCRaX+B9vuu3m6SOn3wQZ5y+R2fUuLFiTr5fJkxj1yh5D5GmKArRM0RK0zDa+MRodC3xP8/xTj/3L++4Z+529ezaCMJSrdRbnligVA8I04fGnjiyGktu7MliZ46xeNvs+scYFnjkcDofjJ5Vf5weU0xwOh8PhcDh+HHGCmsPhcDgcDofD4XA4HI53R5a5+aO/Mvfvfud/ORBW5Pc/dNfV5UAYSBKs1AxUAq7Zu552PP87n//8F0Y/9on3f7oVt5AGjPGQBmI/zNKesgMSJXDLfbtePjX/xvPzcfk9dWHxtUEKmVcY9gUeD0jx6BC2z7L/2k387SNPsHABJjY2SHVE1I2pljNRJxOYBNpkyWE61TSbTayAUqXCgVt3c/jIUcbGJpjYspmFmRnuuPcuXv7+C5yau8D0CwX2XnUNVRNTjGFuCSiMkPbOI0wbpTSlkkWUBQNDFdYriZCWC1OLWAtRBGEIE6OXyFG2HysGK7aJzQrtZhy8xAAAIABJREFUhCVL8Oo/ay2JyeSS/o8K45HVfUZgysxPW/724S679sD2XTXCaIHGMPhSsbg0R7FQwcSSKLLoRKBUAFaSpIpEp4ShRaeaXtwliiHRZMWReQpXq6WRuVMncimsf19JDykzKc3aLJHN2gRj+rKSAaURQmfiUd6quZqypqjWayil8H2forRUMJSkRRYkRlhSG2MRKE+gRALEJGmW8ScVa2QimYW1iSRLwspNmNWyyouT0i5ajnfDgk4EKI+CX2BspEYalnn828cRAu66r0xjZIlms8n4ukHSpIXyLDI/SXtxgEY2pjUPrabirRXT7CWVn7lJZT2SlQHnApowGCuwNiW1YE1KalK09VAiQPlFLD6hMGgDOsnS8qIkJk1TOmEPMHlamsKkGm0VxqQYazHaoPvP54lqQgqUyn6VqHW6Ip0ZoyH3u4TIZrw/+/1EvfragBEB68aG8++z9xAWPE8QBBJEjPRSpDIolSJ9jyQK2bFzDM+f4ZFHlnnvbcsUS9BaSin6Ht0gQdpV4dPaLDFtJfnBZgmCQq6KaH05bXWpcpEqT1HrIxXs3qOoVupQLoGUJEtLaB2iW4uIgkdtoEisy8wvGBp+DRMoRobW891Hn6fdidi4YZzrrt1HHBkq5TpxlHDi+Dm2b78CP7B4viAKu8RGgxRIKfM9kp2DzD8LYiHQ1qO52OGFV88d2bf/+n+vjcLk6YH9c+9Lev2kRo1BirVJZbmohwEkEoNnUwQtpJVAiUoh4OlHv/W/33Pgyk9fc9UWVBKRxBZflhHFKu1uyHOvHAlfOcuB5QpzPbVGULN2VQE1AdlnOU5UczgcDsdPGr8PXPcuz98BnMq/HA6Hw+FwOH7scYKaw+FwOBwOh8PhcDgcjndHBEynZX7pN3/92Fcf/P0DNm0/c8/NO8vD1RKRBissMjYc2HcdE43lX3v4698cv+WOvT+rdBGjq1gKCGtAhnhWYY1PoRjQiyNOz/GrLxw59cwdezcAYVb/KUxutqzWvS0szlOtDFAsD7F753reOnmeDRvWITxJ2GkTxzFeUMaymtgllWS5vcyZ02d4z803IaVk/fr1LCws8NzzzzNy6hTbt2+jUFTcfOt+EiP5/MOHeOOrZ9i19WqC+gZM6TzzzSUC28STHTwhsViSVGPjLOVJeoqx8QIAqdFZBWY+brEiLGX3szt9iyZ/TpiV1DLIvJ+lpdUqvuzBLA3KSMD0eOThNpuugOv276EbTVH0FcttjScttfIIy62YTjel1QzpdgydzjKJhiTJqhQ1WUKYVPmXECACrBRYIfGK/bEpwKO1FAISm5/D5IUW2Di1giYwPT3NHDAtBecRzFnFHDCDoA14VlAAlLGUpdCjyl8a8HxGgoDRgmRktMhwQTHu+Qx5Hv7EOh8/UBQKPn7gU68X8X2R1X/afg2mQUiNEhZfWKRcrUzN0ur6clpfAssknsvKaWsfs5kUhvXQRoIs4QVDPP3kEZaW4I67thClp2i2YXx9Fd/LUuekyCosrTWX0dMujxQCk1c5rkprIp9rL0tYE5JWq4tB5pKftyrg5Sloy502Bg9LADbgjWPTpAnECUmasjC/yLROmQ8T5tKU2dQwZy1NI5jFpt1uB40lJuv6LVnJKDAGjAnBRs9j1PcZLATpusBjuDHke9JmaWkIzchwVt0rEXlGl8zXR4CFM+fMynCFgKkL8wjJSoJapQTVWoXBehE/KOAFCs83KM+ipKQbdhkearBtxxYWFk7x1CG4774anU4EJUWn271IRRyoFfNRrC6ssCa/5gyZ6thfbxBSASKr182vX8+TVKtFhBCYNCVKmiRzi6QaBodroCGOIqKwiybCqkEGRwbpND1efWuKs986jCzAwYO3MzFcotPqkMQB87OTvP7662y+YjtX7txCkkboVHN+8gKlUoWhxghJkqw5myyhTqOJUURS8dIrxzk/zyd2qwo6Nfl+v7iKN/scXJX1TH6ul0PpIsKk+AaUTfGt5sVnnv78Hbds/eTuK69grtmkUapS8DxanZhCYZC//vbjvZeP9Q58+Bc/fuzPvnmIyBZXrq2+oJnt6TrgOTnN4XA4HD8JPA4cXHN/H/AY8BUyCe26NV+b17zuo/lrHA6Hw+FwOH6scYKaw+FwOBwOh8PhcDgcjnfF4NGWNaQY5qc/9UuvfuGPHrypJE8+eeD63YP1WolSsULcVBiRcuW6DfzUPdEnv/y1I+suTPHAp37hZ5etLjCgKsRJm8BqkiRFUcBXARs3bnj2rfNTf7S+pn9lx/oaUlrKxQLtbgdsJkdZA165ivXLpFKw85prmDnU4ujxSTZvH0F6PnFqwM9qIzU2C0Kylm1bt3H41cOcPHmSHTt20O10uPmmmzhx4i2Ovfkmy8vL7L9hLzZsUx2ssnNble8eWaBxzb0MDnicO/GHlAohntGoPOnKWvBlntgmAatJU92PF8vSj2wWN9YX1KQQ+flkaWlaQ5ImRFFCmmTVi9kLs5tMLAGlMnmmVGmgU8HQcJ0nD52gMQY33LiVTi+hUFiPNg1m56c5f75DEMzRasJyBwoB1Gpw4gyUinDd/gmazSb12iDWWlKTyVWpsXTDmHa7Ry/qhnHMrNY0y2VvanYuPT89yTyG88AFK1jQhgtpwqxSLN904Ib21iuzSlIlRSYhSY3wDELIlRpQhEIItSrt5XWSwoLUloe+/HhJSuqlImPmcLJFyGTUk+EOIZkYG+XKwQYbA58tA4Mew8MlpExpDFYp+in1okdzehblZXPmq0xuKxT8TJJC5Gldl+7uVbEnGxRgPQrlIeJOQlAZBF3g0DePMHkeDtwyQGJm8QOo1QVKxSS6gxQir4Y0aGPe0cVZPff82hISAwTlEr0ootsx9CKL7wnCSFOrlokjQ1AZoNtNMFbS7WhmZ5ZpLYUkWtDupqcW5zkbp9HxMO5MxTHH28vMWjglYMYImh/6qTtCI7L1WH3vLJ3LCuh0ehfNhbrkDJrNJuVKhe98+4VSpcJgq52MSst6oCEE67pJvEHCINhxARtGBhms1moj1tpqqVxitKZWjp2lpSnCsEu5Uub1w5N0e7B7Z8Kbb3WoV/KVETA87DM8Ukd5dXpRgjZNrr9xnEe/Pc2RI8sceO9VtDsLaFIEFpXvqeWOxmJQQqKUQCmFEhIhDUopPN/PkgFtmiWM6b73aLE2T14TlijurcyHEJZCUVIA0qidjdGzVKRASkur26Y6UufqAwcxzQUOn3yYHeuLFMttZucWsLHPq6+8SuCXWL9+PZu3bMAaQ5xETE9Nc/ToST70oQ8S9uKL5t5aTbfbQgUBkQg4PrnAsXML/+G2uw+8bkwBoS6us+3vMSFEVn8rBIJMguwn/OU7AARIE0CvxkC5gZ+m/OmffL62bRtfu+fglvdt37GR9tIS48PbaS020Z4mqNf54kPfXPrGod7t/+2v/fLhZjJMrM+T2ixBbW21bfaABxTXXmXvwjvV8r5bXa/D4XA4HD8yfIWLBTXy+5c+dinX8cMV1AbzMTz2QxyDw+FwOByOnwCEfftv5hwOh8PhcDgcDofD4XA4VtDA//XZP0H3FhhgjlGvyatPfnnzukH57fcduH57o16GKKFeLzPXmsKvFZhtT/PkU0dPHXvNfPi++z726rHTL6NtjGckSaIxSNJAkgSCqDNFsbX4+M17B963ddt6/IIkiiJ63YTlVkTYzVK/ioUaSvkI4bMw12ZhcYrd144z3KiQRFD0iniFvGYur+lrDDV48cUXabXbvP+BBzh34gRxkjA0NEISx7x6+DCddov7HriX7zz9GEcn2xz8wAd58Y2UJJrhzv1Ndl3RJe0tIvLUpZXaw76gRi4cWYmVefqVEVgrMNpgrMHovPbOZAlNzSZ4Cvwi+F6AoYDRFmMMqTFUqhWEECiZSV0z00vMzXVpNWHqAtx+cICR4TGOHT/F6VMJGigUQHqZY1WvVShXBpEy4Lnn3yJNsePryp04jucXl9IL7Q5z1jClDeeNZaEXciGJmYwimnHMrPKYfeCDm4yVAkkBHdfBFlf2RFafamh3uxSLZXyvgFQSKRWgsTJFyEz0ySQomclpZOezkmJms0JIzytSLBZJ05gkjbA6ztLRlEEJTeBbhNT8+ece2yoUVwQe1xjLNVdsYu/YENc2qtTGh4tU6yUajSomjdC2R5L0EKTUq4qgn8AGK9WH2cmkq/2bVoApgi1SCAbBFvjCF4+CgXvu2cbc4kkGGj71qkehZNE2zNSZXEjUBow2yJVft8n8NMXF91l9XmOJbUpsNalW6NSn1wMlqyy3U5RX4cSb55lfZDns8cr8AkfayxzG8spyhzO/+Et3voX1SI0kNYJUexjtgQlWqx9FjJV9C9KsprXl4+p0O6sjsquSE4DVWQ2npxRxnOArlT2mdbY/VYJSywiZZGl8NpvOv/7rY8NhyNjAIEO1KuuBdcAQgg1DA0wUCmIwCPyJWq0yNn1hsRYUEDu2baBWLbI4P43nQbvTptMGvwDlKoyOwsToMDYu88g3zrJ5OwwMKurVgELBp1QqUQoKJGlCmmrSOCRNI7ARQkLggeflwXMiqyIVAoTs19j25S4JQme3rKmOzRdWrO1rFRZPeWg1xonWBl58dYZ4oc2N1+3n4a8+wuZ1DT7wvts4ceR1JidnuO3WO5mbmyUoKIKCpF6v8vDDDzNQH+S22w4yNz+Hp9TK4SUp4fI0QbnO5JLh0LPHOm+d7o28/977Q88quuEyp5aOoVW8cm2urN2a3/taq9fsyzWYMtdffQdJx/C1z3/+6n271//1rQc2bBkYslQGSkhVYm4mAlEg1jGPPvniWxfm7Z3vPfjx0x07zuxywKPffYlUBrmc9na+9Fdf+jsEtXd/VjpBzeFwOBw/gtRqtcs9/BXgI8CaVOW/k8smqHW73R90aACUy+W/6yV3AJ9hVaBrAr8OPPgP8f6O/7IR4p3+yU1GqVR61+fd/nE4HA7H5XCCmsPhcDgcDofD4XA4HI6/A8O//ff/mqHBKguzZ7lipIzqTvK5P/zj2oG9/td/4afvumXTUJlup0m5PsJsa44OLXqJ4ZWXzurnXpz9xJa9e75spI9IYrAJqTR0laVbkhSE5e4rd/L8Y994cMOmwfcj4oFWqzvT63B8uclLYY+Xux3Ol4pI5bNJCCq+CnpCxT935VXle99z/R7SZopvFcVSESklcZyipKJSrdBqtXj6mWfYvHkz115zDcvtZeJIUygUmJ2d5ckXX6W0cSd7b3kv56dOI2WXuPkWw6UWt+1vQDSHRWD6cpFdrRG1ufGxmkqVCUqYTOBK00xk03kimtFZWlqcZkJMoeChvAql8ghRz9IJe0RRRBiGdDtdWi3o9qAxBFrDsddhbBQ2bCxy5mxIoQgDI1CqQrnqU62OgKixsBBz9uwCL77Q+tNOhwclnFhu05SK1p1332Bq1RoWTZqmIAXKk0gL2qQIY1CeR9iL8X2PwC8SdhLWBvEnSYKnAsqVMlGYIIV30X4xMskENWkzQQ0QUmSCmlwp4swEKuuBLVCqVGl3WlQqBYyJENIglUEJS6nsY7UhDEOMBmEl1kC5VOWzD35pMOqxr1zhpk0bua1a45Z168TI6HiZ0bEa5aJGRrMURCYneZ5EKbkqz5Fg5FpBrUzYlQzWN3Do8aNMTsKdd40SRi18zzA2PoSUGm3/P/bePE6u6r7Tfs65S+3Ve7f2HQESWpEsQCyywewGEmxjO3ZMMs6bzCSZODOZTCaTvCaTTObNZN6MkziLJ3aM4yU2tjHYrLIBsYlFCC1ISAIhtfalt+ra6y7nzB+3utVq9SaEkIDzfD5Fd9Vd65xzb7XqPHx/JQQV6k4eKhSoYZVZhwtqkbioUSpEaY1WglBIPMum5EO5FFCt2Rw5WOPYcboLedYfP8aL+X7W2zZb7rrrtpzlSoqlAo0tDdR8jyAI6S8UQdpY0kFLa1DQHExFq6f/DfTPAKJ+XuVSZdC2FBqkPDEhJeplLz3PI+a4hEGIhYW0ZF3cUmgrKuwpZDSOVKhJJJIUS3kS8Thq8PvH+rFDRaFYIJ1O8OSTG7LFAk3xGHObGrl7yZKOzy1bNhfHDqhUe8nnj1CplcjloJyP2nryJEGtqtm6FRYulBSLCiGIEvSAtrYk2XSG5qYmMhmbqteN1iV8v0YY+oNldqU80UuiPj6EiCbkhIzEMwAhrHp7DQhqJ9onlAFWXFLVIOKT2bhhP10HYPbsCzjQs5SW1HQObvoBqniA5ZcuYNq0KVSrFXw/YPKkaTz/3At093SzePESWlubKBSLxOrHVQKk8KgWjpBunsTWvf386Kc7v3LtDTf+dlvjFLoPHyWRFGw/uInQrp6S0Eco6vuJ7l4jS2qSOdPn8vSjr9zxofnNP7h+9SrbtRQ1vx/P9rBjFi3NHWzfeYBv/nDL+n1d3PRrv/Mf831FiWU14IdJHnn8eXztDPbx0PshwA/v//6IJT7VCL+NhBHUDAaDwXA+MoqgdjfwDRhTUHuaKK1sHVHpz86RVjrLgtpSYNMoyz4MrDOC0QcbI6gZDAaD4WxgBDWDwWAwGAwGg8FgMBgM46D4xte/SqVWplqr0ZiJ4Qb9xHWOmH+U11989Fsf/+jSz86d1kKxWKGGT1VWqQQerc1tPPHUK7yyo/u/zZxz0ZdsLagFVaoypCyh4EpsYXPDwkupdB1l7RNPO5ag4WMfW9WNdiHMgnbJ9xdJxmNYTogQFkHN5qFHH7j+6us6Hp8/p5V04BLWAlwnjuu6VKtlHMfBshwSqRS5XB/Pv7iBTEOK1Vdcg8Qi0A7f+eH9NEyeyZvH+vmjP/9Ttmx5jp6jr3L18gwJjkC1CyFCQhy0GijjqAeTiSJBrV7SEyI5CCgX6olUAtD1cpbaBi2R0sVyEmglqNV8/ACOHstTLvnkClAuQSwOjgupJLguTJnWSqUc8rPH+pg5HZpbU5QrJeYvbCfdkMTX0J0rcbyrQF9PwMZXgvt6evlf/+ZXr9xQqVoU85K420TN9/B8D8ux6qKUXz9PhYVAWgILQbVaBaKJrSAMCWonlx1MJlL09+VobGwk8BUnSvDV07mEX0+lqgtqQp0kqBE1C0JK0BKl44AkDL1I+CIAoZCWjsq+JuNUKjViboJy2ScVzxBzU9SqIZYliMcVnl/Cdny+9rWfpryAK6ZP5frJ07i+JcPiC6ZAYwJSKQdpCRwHpCWwbRHJVcIHEZU7RSVJJqbx1M93ceQIrLm6kYYmB02NdCpBtVLBsiVCVxFWNepiFaX8CSHroteJ9oj+aw+WNFVIyqUqChuFTShcOo/kOd4TcPAQW3u6Wdvdw1odsv5XPn9VKVQpAq8ZKVKUqnksS2M5GjduUfMqSNsi19+P4zjYbhzHtimWSgyVfrTWkZgkTp4oHZh4Kg0R1CSnTkj19+VIJhKESpFOpAjDk/eTSCROxAkCYRhSqVQGjxFNYA3RkYIQIQRuwqFcLqO1oCGdINAlvnnvMytnz+b3Zkzjk4uXzmXKlCyuXcSxoFQM6e3Ksa+zl9CD7i64+uo5BGGFcqWffL5MuQy5HCRcSCYhGY+O3NgEkzsaaGpupNifAxGgdQjaQ9dL9+qo6iXp1IkJtwGRMZLTFHqgDes/A6mwkhaHu30SLnS0ZAgqIetf8Ik1/TZXXH0n3/jT25k52eJIvsiVV62mLelArcbzz7xAf3+JSxYvYM4F8+jp7sa1HdSg6ahABOSLx3HTrTy/6SCbtx+9Y9mKDz8Ys9M4gYfjCnbtf53ACtCWrsufA9GOfiQM1uVSTfRcKBuJAlFFCI+3dla+dPOHZ9xz6fz5iIqHK2wSSZfADSiFHp0HjvHcxt3fWXLFJz97vNiAlZpBviRxnTilis9TT7w0eAwYEOTUyYIanCKpGUHNYDAYDO9lRhDU7gU+P/BkmKC2D/hyfZ3cRPZ/FgW1RiIprmGU5U8Da4xg9MFmAoLaLOAOovEE0djuHFhuxo/BYDAYRsIIagaDwWAwGAwGg8FgMBgmgBr2ewDaAzxQ3dx+wcX/9T/++sV/tnzxVCpeERIZ+vNFEo5NKhHjyOFuvv+DzQ97Pp+54Y41eZVOkfMDdCyLCjWHduzGoQoyjyRAKBcdJtBeOiqVqQtALSqVGcaQupl9B7bNWfyh1FsfWj4Nq1Am4yRJxBtJJmPkSkfROiRUDq4bB0eAFPx07bOg4cJZizjWH3CwKlh52eU0OQEPP/BN5szPcv31S1HhfiyRx8IDfHQUkTXYAgPfpwghQDgIkgSeoFLz8XwPP/CoVsGNQTYLhTwk00mkTlAqBhw80E+1BsUi1GrgOFH6U0MjtLTESKQTSAmWbWFJB9fO0tNdoLsrT1NjC/F0nEqlQL6QI1/26e53ON5T2Xz4KA/rkO+lk8ltCgmyiBZQ6Ad0JM8pEYlUWqvBiTOhNVKArJcW1FqNWq7vVE6WR5QYMl7GnteoNyZIPVxAObG9Gr6PoeUztUSiyOfV4LEEUcnGgT06sHJaA5+Y1MJdF1zIjLnzOrCcANvxyfXnyTQJbEeTzcapVKukk5PYvOEoG1+Baz8SJ5YIaWywQQQnErR0dI62FZ2nVnW5SdugXQaSy6QMUQLseCM9PUVCNHY8RbEKFU+yfccxDh7hyO69fFspfgBs0PrEexQiekOCE3Jf9NrQRLSJMBHBJ9rfSGUgh/bBiGUiJ3SMgbE2dJOBkpoCIQVShoAe6MtLEHzKEtyyfAFLMynIZlMkEwkaG5uIuwl2795DIiFpnxwn1JUooa5eXreUL1Gp+BQLkOsByzpxnWVT0NaaJp1OEKgSqaRG6SpBoCEQgE2x4OO6gsambD0NMETKsJ4WF9QHWv192BZ+eCKdLObEEeoinnsqxbYtndx28xRExuZHzx2ivW0ms2Q/XW9spTEZY9GSBbgZl1ACoYXWgqAWEI+7FPM5PK1ItLZytKfKho172LCxa86yJRftRSiEqCKVpC8XEgqJ79YIJKBcJAqXGgDz5i0hlW1AhSWyqSy1PKTiNg8/+N2s0Hz7uo9M+djShQsIKj4y1MTcBIViH3YcXtiyi/uf6f/jMvyZpxvxVAuebsbXMUCiBTz77PMnCYrDRUith0ULDrumEwMT6APbDbsfiLP89bWZQD23TKAE3Zi8H/tPCIGUEilPpH0O/P4uMYuo9N8sTqQ8jcj7sf0NZ8a7OX7P9fhLp9NDn94DfGnoC/W/s08qm3meMFiGdAxmM0qy2yjM4sR9YzMjlCwdzrnuP8PYjPP5fA/DxjvRWF9D1P8f+P49079v3iZLifoAos/uzaOt+EHvH4PBcO4wgprBYDAYDAaDwWAwGAyGM0P38vA//Cee/sk/375gLt+99ZZrkiqWolKuImpFEtKiNZPhyLEeHn1q48Ed+/jl6+9c/VSqbTp9eQ+tLDp3v4kkAFlG6CiRSwQxwiCJ1iFaF9DaR4USHcawZAPlco6jXW/cOWcGX1o0a+qiaW0dxGNZypU82cYogcxxM4QeVMtF0i0t7M/leWXTdnqOF/jVf/u7NC9bzbf/6e+4dmGWpx95kCXLm7h46Ryq5UMgy2jtgQigXhpvMDntJP/ColTQBMomDDRhGBKLR8ltWocUS0V6u0O6e6BcBseG/j5IZaC5NUM2m8WNQTzuIqQg8H36i/31Up81alUol23yuYBsNt3b01Psz5fYX6txuFLm9ZrHG1XNxliSt5KJNEo5KD8RJUTZORBeJKghBpUmISVaKZQ6IVwNFdRCrRjrO6NTpLHTZLjkNLr0NLHjFftPfj50dUfB6uVNbNvUJ6s1Pjb/Yn7toou5pWNyA9Nnt3P0yFskk4qGbJJMqoU9u4/yyEM+t93WSEOjxHarWLIGhNRD0AaFGQsBIirjKjSgbMBGK2vgzAmFTb4EuYJPx6QZHOsr8/obR9i6PXyuN88/9fTx/UyGmh5I4RvS7lG5SeppdCCFQAg5pCdHa79h0uAp8tjJCW9yhPKfJ20/TvuP13/DGRSOpKiXsaynE8pTD+TgU+ljbjLGpYkE82MxFjQ0MsWxmZHNygbLUc2WDbEEJJOSZCyO1ppkKokQglSygbiTobenjyNHD9PX7eNVIQijhLXmVmhthVgMUolYPSnRilIDhSKRiOG4GiFDLCv6KawhAqYGTdTvA8l/lpQE1Rbe2pZi+7Y9fPKzK3nsxR3c+hvf4bVNu3niG/+ZxR1x2htaWLRsEce69yEdm7iVwrLi2JbDnr17cSxByVfsy1V44ZX92/I57ll8yYU/0kpE9yVZBW2T744RCptarEQoFeg4llLERQmhYcXKj1L1AxLxkKBaQQYO93/vR9esvmzSt69ZvWBaQwJsS1PIV5C2QyKTpVz1eGnDK5Xv/LjvM7qNB0oiTqha8cMmfLIoFUPVBbXnn3uaUyXmoU+HDRAjqBmGYAS1U3kbgs8aIgFmTf35l4nkgdNlaX3ba4a9vqW+71NSn96P7W84M96moNZINIbvAJYQjbkvMoYcCed+/A0R1NYATw1frpT6a6JrcUKJae8SdwA/nsB6v0t0PxiPWUTy3YTvGwOc6/4zjM0on8+NRNflklE26ycaE7kPev9O4O+bRqKSwHcQXT/7iO5748qdI3AH0fU6c9jrf8Iofw980PvHYDCcO4ygZjAYDAaDwWAwGAwGg+HM0Hnu++ofkg6P8NN/vX/u7Jncd93NS5fPntZBOpSISoi0UvihT5io8bNnX2DrzuIfrbrm2v8e6BgxN8GuXW+e2J+IytpppVEKlFYoFT3XoUQrMVgCz7UcQq9M3/FDH5/Snr3LFcmrtaq0NTWHYtr0dubOuoiGeJogVyKQNv/8yFpWXf9hGptiKNfCTzTzzNM/4t9/dhmV49sAiZAKhAeygiYqU4gSUSnKutSlFCgFA2lXxTwIK0riksIm5mbwfJujh0scPFCmrxekAx2TYOq0LO3tk8gIn2zZAAAgAElEQVTly3R1FckVqyAtenMlcnm6wpAdXT3srFU5WK1woFblkFb0C+hSIV0rVs4pJpPJ+rkoAhWyfeebSBscx0GKOFKnona0olKG/Xk1UHcvauK6oDbwvdCAYDRagtpwQem9JKhJDTdeuxLfKxOEJTQVXnz52PJ4kt+77PLEp5cunklDMoelINcVZ/36TubMhUuWtHHsaBfTpqejcSBCrIGUtqGCGtGYBOqpfToao6EkVDG0jqNkgv6CxZudOV7ekH9k/2H+4vKr5jxjxxMESvLyK68NpqYN/apuQEwbeLxtQW1og4xQgjQS1Aakq1M7Q40ThTf8+BMWiuqCGlZUClZg1fcnB/crUMyY0oYlQizbxRaSUr5AIpng5RcOpeMJ2sKQtlichmSKqfEE02sVpk2fzkU1j4unz0i0xRMWiZRDJpMilYiRScU5eGg/XV0FAh96u6GlFaZPdWluySJ0jZgrQSiCoAIoLBtsWyAthbT1oKyIBqGyRIJadO8IVRlLJkmnZoF2KQZ5fvR4Jyuu/Sf2H+hmbsNLHHvjaV59vodP/sINTG6LUSr00dNbppD32LR5G56ndSIV7+rOV5/Zd5zvT5k194eZVAt9vTlSmSQwIKi55HocAmHjxwpoGYB2sZUiSQFLSZYuu5ZYLIHn95CK+Tz84IN/eNnymf/9w1ddiVfsR3r94NeINyaoIdh3rJe1T23ddKSbT97xqTt3//W9P6IqXMKw/e0JauN8/2wEtQ82o0zgLuVECbrOsbZ/P/bfaQg+jURiyEhJSN8kmvieKHcTTW6PVvJvxEnu92P7G86MtyGoLSUSXkYaex/mPE7wGyKoreNkQasfuFsp9XZEk7NNJ6dKLCPxIJH0MhZriGSa07pvDHCu+88wNqN8Pt/LkDK2o/BN4O4Pev+OI6gtJbp2RroWf4XTS1y8l7H7ZBkjJKl90PvHYDCcO4ygZjAYDAaDwWAwGAwGg+EMKfPVv/oDmt0cWX2MdLzCw2uf/cdrVk3+9VXz5mOHipovsWIuyqmRbm7ltZ1HePCRFx4/eozP//Ldtx7buWMPGjsSHqQitMqEhAShi1YOOtBordHKQ+uAmlfCdZK4ognLtpl/wRS8cp7XNm9LBrW+v5gzx/2tZCzEwiLjJIlVJTWRZeaqW9m0ZxsLL0nys3U/ZX8X3P3ZZbTH99KUDKlVBTE3hZAapapoUYykidACbQ8KXcViNUrNEvVwIBVD2nHchIvrJHnxhX3094HnQTwGixYtwZLQX8rR1X2M7q6qKlfYnsuzpVBhWy1k9+HjbG/rYP+KFTPLfhClODl2AkGMMExRzPvEYjGU1lSrVYQQWFIiZEjn/l3osIrvR3KKJTJIqY2gBqDhiiuWEYvFQARUqjkcVxOqCrveOHxd3OJ/3Hxt44rJjQ1sfHkfrS1xLl6coTfXRUuTS0NjCs/PjyioRZOtkaCmBVGqFVAsAKGL0g1olWXXG8fZ8UZh52s7+MMbbl76Y18kqQYaabv0F/Js3rzpxOmOI6hJEZUPHbv93qagNooJdDYENS04kZg2gqAW7VMiNFw4/2JQGqVCdNTEuLaDX60RizvYDmj8qJSkUMQdiSJg7do3kxpmTJ7KQtthXizOItdlcXMjC2dOb5KTJncQi8XoOnqY3r4e+noVjg3Tp8LU6S1kMgn68z0gAiyhESLEcQVC1oU1CQIbVLZe2hWkCLEchePYhKGkWvOx3TiH+lr56vcKzLtoCUvn93Nw72ssX/gxXnjiSWa1lAmrxykUNeUqxJIZOvcX/rZU4g8uu+r68s69x/GUjRpwCIWOys2KAK3j9PRZhEISuAW09JChRUz7pHQBS8GFF64ik8nwkx9/q60xyzevunzuTRfMngaBpCXTQJDvRgiNlYyxYccb/Pz5g/9n1TUrfj3dOIMqMf7h2/9KgE0QdhCq5rMrqJ1S7tcIau93hk3gjpQA8tdEiSIj8n7svwkKPuOl2MDEJ7nvBr4xzjr7iFJxTuL92P6GM+M0BbXx0rwG05hGWniux98QQe3LwO/Uf3+a6H3llFIjbTaUpYwuga1jApLuaTLR9DSIEtCWjrF8DSOkxg2jn+heNSLnuv8MYzOCYLWG8fsc6v3+Qe/fMQS1saRciNpvKRO79u9lgsLg8Bc/6P1jMBjOHfa5PgGDwWAwGAwGg8FgMBgM73VsnFg72oKqdxjp+Xz0+o/8xk9++OSLuQM9X/voVSutlkkpSuUarjONcl/IzI4O/p/P3nzD2p8/uf3xHz9098IFix5y3DQHug6Rbo7h23lC7eCHrWiVATSCKqHVi8ZD6ziB5RKoEBVoen1NtqmNCz+0rPzsUz87+tGlk2nIenjFPsqFfoq9cKxXct2az7C35zuE3iYuX5phYaHA7KYiue4cx/IQKhuBIuYmsG0bZBzH0sTcSE7zPI/AD/D8SBhyHJt8IcB1bZqy7bz+eid793RR86G9HS5cNI1MQyNv7e7k9W39e3q6+Fm1yhOlIi+t+tC8/ZdcMomjPV0I1+WihRJtQcULEFIT6pCqX0KHHjpUhHYMzy+jlMayotqCWitQAX4YoMIQjcS2rSjeDQ3IuvBx8gSZHj5hVhegtA5PvCSHLj55UtHiNBlumIjhi8cWoMbz4UTdkFJiFNlNamp+FSUV2C61sIbrZph70YyfB8Xcz3/+aO7zdpD7XwsvoXXl5TMJguNMmZQCJNWKh7DqpV1P2bdGixA7IZG2RS4HpTLY0sZxWjh20OPFF9/qPn6MP506Y97frFgVUvBqhMInFBLlx7DisUGBTFLvB3WynCbrMqRAAyp6j0Pb9CQBTXCqwDakM0dqn/FKeI640ejbj9OdQ7YbECSjEaZlJCidEOoUEokSCi2j8a7taGFNexATVKiSSVgIESCQSBUj0DYgue7GFWVQOzX+zkjAUwgCfv74mzO2Nfatam3ru7apQXx08vTUnIULFhL6NY4ePsiu3WX27Oth1kzJJYsuoqv7EFr4uDHo7SuTTEMsBFwLKWyk1gSeR+ALwKaQ9wkDj0TSobkxS7Gnl8nNDdx4ZYWq2ElfIUXrzKuZfeWv8sOHniNd2ktHGuZMBzfdCNZk1r6w4+idH7+1XPMzVMgRoEAqhBwQ+SToJFonqQpBKMEXARKBIyCdThLm+nFQpBOKf/n6t2659tqOez+0/KLWVMzBKxZIxROEXpF0cwPdx/t46tGX1Utbil/42F03fsOTLoVagC+H3Tu0Ro83Ht4ug+N0uKQ27gT/AGuIJuBmDXntXk4vhcJw7riXkSdZf4doIvd8TCI6l9zL2HIaRMlF946zzkBZz/GYSXRtdU5gXYNhIsxi/PHZQCSo3nOWz+VM+SLRexkQR8fjbqL3NFaS2ZfqP/s5cQ98gDMrFzqWcDacse4vs5jYPbmB6LN53Wkc13D+MqosPgzT76MzcI8YTU6jvuwexk9B/SLjy2kwglxuMBgM5xIjqBkMBoPBYDAYDAaDwWA4Y6SWSGUDNqFwqdYcbv6Fm+9d9+AjL/fnnv/25atmLps35wLy+Txg48ZDAl3iY9df1fLqqzt++vzzr/3F3Pmz/yDj2tiWpCICAmL4JNG6Eak0gjIhHloIcKpoqdAEKCRVJ0BaHoETcLjAPs/xkClNJpYgmXXJdjj07KjyN//j93EdyB1fz/z50Nok2L7tTYq5KLyn5gfYVhHHLiIHLCwBrS3g2uC64DgSx3HRWnOsy2fa9FaOHC3w7CNv4rrQPCnNrJlzAdi6fQvbtx98oFrmny5fNfmRGbPace1GinmFbcXp668RBGlsO4ESCqF0PYUrBOHXZaKBE1FAEEk9J6VQKMIwBK2xbRuBQIpIYKv3ztnu/vcOWgIurh3DrwU4doyWtiauXpz+5vqnn/+f8y+KUygfIBETw9KcJEKrSOQbYbcKm74+j0oNGpsy9HX7vLTxCL4HgcK7aMHCv7HjrSingm97BKFHoL2oh3QIVr1bJ9plY0VKCT22ISZUfWjIE88nLgCdVaJEv2gsh/Xz04QoqaKyqTJK94sWROlqSEUoBUIK0BZKWAglQdvROoBWscH3rXXIR65bsl9I9lu2/oFteTz97M6bt2x97Qszp/MLl61azMzZgu3btrB1u2JP5+ssWpxkxrR2iuU+GhvTVGtFKiFUqiGuo9m/pzp4uVkShLLwfU3NV7zh9ZK0IZTbaZ6cInA1z77wOi2Ta6y/5zcQ9DF7TjtZpws7EUM5cQ4c7eVQL/t6qwUCLfCooi2FkBohrHrJYRdUmpA0ntD4UqFEFSkUlozkVNeW1PJdPPzQT/785pun/ZdrVq+gr/swbkzS2tZKX3cPsVQbb+49yPMvbt6yebv+7Oe/8PFtfdUAhY2ox9VpBUqE6IH4unefWUQTnbPqz3NEk3tDyxXdzcgJUNcQTchPdFLVcG64l7EnWe/hAyioKaUiWf5UljJyWc/hzCRKTBqr7cYq6zmcWRhBzTBBxhi/A9zDxMbe3Zz/ghqMUEJvBJYyMbl0KA1E1/vtRJ9z36zvY91pnd3bo5GRhbjTuW8Y3j+sOY11R03O+4DzRSZ27YxXXncW7437osFgMJyCKfFpMBgMBoPBYDAYDAaD4czQVb77lT8nKXJIfz9aVChrAEWz6xIPirz09DN/t3rl5H+3YsVy/MCn2J+nMZMlCH2S6Sw7d+/h4bWvPduT4zMXrbjkYMHOUSFFxZtDGDRhhxpUiNIVtOwDaz9OzEfhEkhont5MNagwKduErvbw2oY3euZMpbk5AXEbdAzSDbBlI7gSFs2DnhwcrcCxY3D95TB3eiu+KqPxsey6vKNtwtAj8HyEhJgDju1g2RaVWhXbddn1psfeQ9DSDgsWz0VaKV5/bT+vvpJ74Pgx/uzOOz+0sVryyfUVaW5upVzykMLFDwWWEyOeTNCXywEqKssJaGGhdRilFWlFqAVaa0IVoLU+uUySUOze/Qa2LbAQdTEnKjeIVQQU/QVvTGlpvISs8Uo8jss4NfrkOJFb4+lTxfzJ+z/pcBpWX7FiSGlLCUpjWRZKKbzqYQ7v6Xzxc7/Uvqq1XVD1ukgl4icdVRDUyzwOnG/9dQGhsMmXFD05xaSOSWx57Si7d8O0aTBrtkMQNvC973Y/tuzSi24qKZ9kQ4ZctRS1eF2C2/jym8h6hU1dfwwkqEGkKEZpatEL4yaajdmeckhbqBOC2tmuozgCQ4PdpBh4Lk9ZeNGFC+rjPxwsSzu4XChS2RRC6EGvTygdvR0tkYBWJzL/pJQ4jkCgCMMqofboaGvCcRT33ffCpekU//XKK5O/MHvWJOJxza5de9m3F+bMhktXTMOvlUB4hH6F0FcEIYTVKLRQWFHfWcRIpxoRtqJUEhw5IFj/3DEa22HyTHCTcbbvqFKpwMqlWXQuj/KhXIFSAG8doedDVy9r7fN8fG1xaP9RhLCRQkfXdpiFsBGCVnwaOVLw8W0PbfdiiSKu55EJS/S9uXPq7Ml894bbLrx6Ulsr2suStlNYoki+p5uYyLBr92Ge3vTGPy5ZdeW/xbIRlo3lxNBIFDa+BV+7735qQhCG7YSqDZ8sWsffsRKf8URiWOm3kwzNLwutfoeRGShZNAvYO+ZB4MOMMplvShydW5LJ5N2MX14SoIkRRIn3Y/8NlEUUQkTi+ZDndYaWExyPP2H0SeylwKZRlg1nxFJ978f2N5wZExi/A+SYuOR0Xl7/Q0p8jsiwEp93886KXU/X99l5GtvczcTutwOM9Nk5i/E/c4cyYt/Bue8/w9iMUKLydP6x8Cflcvmed+5s3nuMUuKzk7GTE4cy6t+unN7fAabEp8FgOK8wCWoGg8FgMBgMBoPBYDAYzhBJiE1InIBWpK2QtqDi+VTdFLn8Ia667sbf/PpXHnu+WH35G1ddeambbsrSk+si6VocPnqcdKPLp35pzVXrnnxt25ZXtn3mghUzHgmES03ZBNj4WEghUWEMLXykkAg7wNJRWcBEQhBH0t+7l20bj/7y/FnYs6bDlOZWMhmbTLPCD2DGpAQx4dCS8Tne10PZbuCNXYc4fgwSdjfTZ0xFU0WLQpRkpiwc10UkLVQQEng+lbJPW8ckenOHef1Vj1wRFi5LMGveJex4Yy+bX33rja2b+L1P3bXsp0EQR4UZioUCbsylt7+XTCZBf/9xEokUijJ9fUeRMipJKLDR2Egt0dJCCIHvVwEdiURC1e2lkyf5bMtCCH3ytMFAApg4P9KxzhkCImEmkrKEkpSLRSZ3tNHTdYStmzr/0403sCqd8ekv9NHalkAFA0lRqu5tqZP2p9VAF0jQLl41ShF87JGj2A5ceXmMixbN59DhXSRTMVZdLm58fv3OLyxePudrwpfYSqIAJYlSvsRACc+h5xwRlfM83fc8VoqaGtImA8/Pj/+BVZ/U1kNLmCrQAi2GvCoGyoFKtHYRwkYJhdQKRZQkJqinxclafZcShcIL/UhUcxPEZSOO00Kut5vbbrlsoyUrv/j441tuPTx/z/9/8UWT5i9atJjmltd5682AH/3wIFeuzpBM2Fh2ilgywPZ8hJWIzkeWAPCqGssW9BdK7N9bpq9HsHRpC+1TJLGkT2NzE4svVIReGUfaJOw2CoWA3t6AXEnRWz1iP/z4ps9devW0b8lYAuwSCBelJSi7Xn/XBeKEuIRCowkQBFiUiVtlNr3w5k133zr7u6uWzWxsmxJQq9XwCcj199OYBCeWYcPGPd5zG/b9m5s/8fFvV5Fo7VOpFJH1e4bUCktJLAWO0Ni6TEAflg7Q2Kh6HeC49of01an9OtYdKBreHhAbafEaxp58+zxRMtRE0tHu4fSSPwzvHhNNt1vKB6xc2ClC+glOp0zfWNx9Guuue4eOafiAMMb4hUhyOh1R671+/d/N6YlhE+EaIlFsLAl1OPcSfRZOpCzgaIyX7DSUpzmzkqSG9y7rzvUJnKdMVE4bj9O5Dte9Q8c0GAyGdwSToGYwGAwGg8FgMBgMBoPhDFGgA8ADAk4IMANJSHn++nc/y6wWwdOPPTO3bRLfufOzl61qanZQ5eO0NLbSV3ZAxdHVGm+80cmjP9v7Bx+7666/yMkZ5Pwmdu7uwa8pJrc30tO3nVR2P4F/AEsHSBTTps0gGdP85IFXF15xOduuuXwyCTcgLFWjc7AlloghrRQCD6W7kFIT0ESlHNLf28O2rZEMdPGCLLPnO3hhL9WyZiD8wPcgFZMk4y309Et+/uQxpkyBZZdOpxI0sntPjrVrD/xtvsAXP/Hxq5VWAq0VWllkkx30546SaSrzk4c3tNkWM5VgOpDWgrCQ57Vbbr7ktWSqnXI5QCmLQIFlKZKZJBs2bkKpEFWf5xs64Sc1HD96HEvUZSZNlLIkVCTZDYpPI00Svr3vhcZNVBs3MW28I0zUyBp5R2LY0stWXwHaRmobS4FUIUE1z9rHNs1ftZJdd9w5h2p1L4m4prk1TqlYq59nNIaj8p66HmUWVeXs7QFLQDyWpHN/lR07FG4Mbr9jMXYSvEoP+eJxiqWAhsb5fOdfdrF/D1NuuPHmI4FdJpCKgDihhCefXAsD/adODpySA0FhIrqiRp/rZXB8DG/f4V//DXTPcIdttO2HM+r2o6w/WsXSE+O5vt5IcpMQaKUHZajBY9b7RmGz/NLLEcJCaJB4tDYm8StFfM8jnbJ44qkXFiFYhMZCUKx6HNAh+267+bIuSzYSVBXFUpGO1hYOHthLMm7z1FObpYD/fc21rf9+5RVpqpU+Nm3op68Lli3NMmtuG553hEq5TMxJ1N9HdL9x7Ub2d/bx2iZoaoTZMzO0T26iHHaRakoS+IJMPIEq51EhVEIXabvYTgi2SymM8dQLb7J+I5dc+9FF2/fufwuFjVQuhI2oYBKEzRBmCUjTNGMuHVMbcMSbOP4+nnnkvt+/8fIL/uLS+fOpFXIkkxaBVijtYguXUneRBx977uU93fzShUuW7j585NBJPSgGBoCWaCEJJGiisqkKGy0kJ8XfDWUEIVap0QeUJxr5+n2b8MWIKTT3AF8SekzJdh8Tn+wb8ep5rydIjJLQMWHO9vtPJBJjLZ4lhJhoEs+ISSLv9f4bjYHEKdd1R0qfWkckp0yEseSV09nPrxDJLSfxfm1/w5kxzviFSJJ66jR2eV5e/xO8/97NOy+nDWcLkbDSOcH1ZxHJwWsYu9zoSO3+ABMrMQzwu0RJTyNyrvvPMDYjjO9OTiP9q1wur3snz+e9xij3h9P5x/dYCWqns5/zMoHSYDB8cDEJagaDwWAwGAwGg8FgMBjOEAnCJUr0GQmbeMtcKjLHyiuXv+W4hcv+7usvfuXaa9t/c8mcZo5350impxOEkIzbLJw3A12V/9/2l9bNm7n02l+zgxpZV1JQNl6gyDZPQqscUiSJ6SK2hljo4OX7mTWd/zBzqkup0IuddvD8kGKuwo4dEAaABW4M5s2H5haB6xSJOYL2jgzXrImxZWM3r7+ep21KCmmDsEGGIC0olqC9rZ2D+3OsXVtl0SJYcukCDh3qZd2zr3W9+Rafv/nWZY86Vgqv5iGlxLI00oF7v/F90dHOf7tkafaGxYtZlM068Ugei5KualXNGzu3PV8s8peLli590HUbEI5NgM/xvi6UUIT1uT0lTshKMKywnpiI/PXBQolIahIowAMBoV8FXWT6dL5z2RUzCIN+HFdjORAE1UhjGZLmpYWOzJa6AOhYYEtoSDdx5EiJTa8o5s2Fq65fQaX/GLZtIcIqjlAkHE2puJ9rPzKJB7uPfism1HWENlq5KJFEa4WFA/jRYev9rHU0PKQ+IXK9Y4hhP8+TMTPgMQ2ObRElsETNHvXF4HgXisjnCwFVL4EZYOHjef3Uqr38/Ge77li4kN+7ek12NcJjoKxpqKsU+qnsP/jqth3bvMcrBf7fW29Zrft6jtHW1oYOFbfceKUSQvzO/T959tG+/u5vLl6abr902QJ27nyLlzfkaW5pYNLkyZRKb514A9oFbWPLBNu39tGUhctWzsR1Q+JpjfZiVD1FUIvz8rMHsD0IAtBx6JgmmDErQalUxkmmmTU7yZ4D5d8NQ+8LcogMprAJSaJJoiwJukpHg48ovAGqkwfv/+H/+dQt837topntEJRxpU3CzRIIRd7z2Lv/MD/9161/v3zVxb85dfk0uvNFQlmXMOsMioL18q+2GigH60U/xxLGRhhLaqwBVi/Dega8U0kU71fWcKIMKsBmIslo8zk5m1OZda5P4HxmnASqd5t15/oEDO8txhm/nae5u/dqCtfdnH05DSLJbDPRPX8i9/dOTqRXnk6pVRih1O8YrDuNdQ3nP5sxf3e919jCe/f+aTAY3qcYQc1gMBgMBoPBYDAYDAbDWcamFLr4tYCOhiwEsHz58t+6/3uvvpq5w/366g8tplYOics4KpTELFi82KWp7fgX7nvwuzNv/fhnru+teaSS0zle6MeXNZx4nCRNxJXAoka+GOBbChXjipZpMwjDPnrKmjdf661ufJHvTWrj5gUL7fb+XMAz63jz2GHeWL7CvqVlcgXb1jQ2tFEuhixeOpn1649wYF+JGTOzOE4V6XpoBfPmNbHvkOBnT1VZvVIyZ/Y8DuzJ87Onjv74yqtX/eLiRYqqX+CnD2/qqJWxXBeRTLIwFmPJJYv4fMek1MKWljjLLr2E7p63kMJDKhuhJY5l0zu9unrHjp7VTzyy+SuXXzP/t5NNbRBzqJZ8QnlC3hnK0CSrE+IOyKHa2tspEfke50QZyIEX3Ho7VEEohBCsf+HN21Z+iBWJdIjnl0lnLFw3xPNPJHqJ+g40OkohCxKATX+5ggolO1/PsXWLZuVKuGTpZCr9uwhCD78WQykf15LIBHTlKrR3JFm6wrr2G99+bM1nfunGdUJlkSRBeghhgfQjX1FFb0AIsIakpw39+X5jIOGtHpJ2chKbBPSAWhbJU2qoYKc1SA8pFBZFhCwjRchLL+3+25tudn6rtdVl8vRY1Hg6+iq0r69Kx5Ipie1bD68s5llZyvML69c//81qlS1Ksb1aQmezhDfdsODYp+9a+FhX95GOx3/a+6MFl7z+i6tWLSSb3cdjjx7guuuaaGyejFfNRTJXGAftsuHlw7Q0w4KLs1hulQCPXFFQ9AS79/bxwjM8EtaYv3Ae81pbYcdejr+yST985VXlTy9eHosH0seyajhJVldqRYRysbRNKBWhBJ80gUwTSEVc58iK12l2C/zw+w+u/c1PXfnRWZM70EGVWqlKzHYo5UtURciGPft4+NHOX7tlzWVfs2WCWq1IjDI2YZSKdqJHzmJvn4pWROmEb5+JpKg9eEZHeG/yZU4tkXpN/bWxUjneTU6nVGXn2TqJ85Ghcs8Iks9mJp58NhYTnbTewges/Q1nxjjjF6Lx1M/ExajzRao9HZYyspz2NNH9dzPRNTjwcyiN9e3XECWjjZVyNkBDfb9rOL32eoDTK/nZycTuP/tO8zwM5z+nk55n+n5kTif5t3OMZRO9f66b4LEMBoPhXcMIagaDwWAwGAwGg8FgMBjOLkLh2pByHPKFHK5tE9LK1R/5yD8/9vSTb+zadfShj1yxvGHa5DZcO40Xeqgg4KILZvH5O92PPrX+xy+sf6Xy4StuuK2aTU6mP6whhEZoC1tbWNg4Ms5T616xr7gq0d7X109Hc5xE3CWTyUs/DKz2SVRmz51LPOXQ2LZn6k9+XP7Lqu+/umI1f9zSAloUsIVNb76X2XNh71vQ1ipobE1gOxY9fRV6c3088yxcckmcxUuW89zT63lxI59effX07z300EuXJtL8u9lzufym6625+UJoJVOIbLpBppMZ0ukYpXKZVzceoaNV0TbZQgJWKJEaKsVuklbImisuoqHh6G89+8ob25Zdbn813dBGqiGBPnRy+UWhTk2l0OLkypoDiUjDyzB+kFAi+o8ghlYKpAciwI0JZs7hy/MvnkQqrW3S4AsAACAASURBVCgXK9hOHEsqPF/Xy2rKelnJgaQuB0iDiuPGG9nbeYAtW+GWW1qZNC8Jfo5YwscKQ8KwGE3OSoEtBZkU1Px+lq6Yyouv7P+yENWlaBAEIAIsoaP0O+r9JU8NqTrDlKlBxBBhsR7gd/rbD/l9ItsrJnb+J5UirSffnSRYDv05cD0QtaONRloVbEo8/eTB37hqdey3Fi3ooBZ0EdS6TkrAm9Ka5dD+w7y1C9Zc1YhrZxfm+6v/8/jx4/TnUEGITiUJ9u57/a1DB3nxyCH+/uabW+584eWeu3S4/XsrVyygXHidx9f2cdONTcTjEjTYVpLAlxw5DMsvjaGlR7FaJpaI01/UdPVarF/Pn5UrHLjp+ln/+4KZIQ2NKQ707Kwc6cGWNjIIavQXobW5mUymt33Lq4fsOZPaA6lsfCsAArQqgbARIiBGN1//y2fiv/rJtid/91euvbyhoYFCXx5bWsSsGJZjEWp46NGn+7ceCm+9eMmS57rzklQsxIlp4paN1AwmNI5KPU3tXaZzAus8SDR5v5nRJ/C3EKXYfJCYxaly2lC+yPkxaXk6STydZ+skzlfGSKBax9j9O3zd0bi7vnw8+cWIBobTZgIJgOuYuOzyXqORU0vi7uPENTceufp664hK9M4ium/fzdhSytuR1NZxeoLaF4nkOXPf+ODxAJH8PhExyqR2jcw6Jn69dY6x7A4mViZ53QSPZTAYDO8aRlAzGAwGg8FgMBgMBoPBcHbRAXGvj5TsB0fgE6PkZbCSjcxY0fDcQz/88bJ0Y+cT2eb07KSoobXAsTIUun2mtk/izluaL9u99/EXf3L/T1bc+vnrg6ZEkpLfDbqICj0sBRkrQaJGGPRWapOSU1H5I9Socsm8jDv1c5XPdfXVCGQPVekzb0lH8hZd/SOt7JmvbjjwyWtvaLzQtkEIj5aOODJMsmNHL/sP9NPUPolcf5HGxjZ++mAXU7KwfMFs7n9ofe/ax7m0vYlw964DT954vfvhbHOcphYbO+Zjy7rIoSUqrBBUS2QScWZMgtc2dfOx6ZMpFUooVcYVYMsaTWlBf24/C+ZPZ+fe3B+ufez1b910x+xyLN5APCbROkalWiEIAlwkUtZNphGkEaHVYKlPBZywc94ZW21c2eg8KRkZnYeMkrMU+EEZOyZY+8SGm268oWl2S7tFX/4QMzqaEFRRWkcpZYOmmAAstLJRyubYsS4aM5PZ23mMnbvg2psEkxbE6D24n2xGEvgKIeuHFdRtLgvXThGEAiVKrFjBkieeWnfFFVeuWe+FmlgmXi+dOOS0h3XVQHuPVr51vBKgYth2g2OjLjWO113jbj9cIBvpHMfY/9D9DTJwTMFJQhrUR704MayziTi1ShUZlnns0YPJpRfzXxbMuQCvfIRMxiZUsi5s2oBL1u5g68E8U5ohYfvE4t0kE4pJk+JDT8cCFqDjC7Zvzf3qW7t71lWL/PL6dcxW3uuvXH/Dh1qKxZd5+aU+rrthMrVyCek6bHplP42NEItJEklJLahSCz3Kns3zL+V3XXH1oj8+eOT1fR2zZZJ4P28dPsCildbMpZfzuXQiRGlozMaoiQx9Pb1eOU/otoETKtzQJiQgCDvxtYMOYMPT25wrF/PitStWLYmlYuRyOZqySYrFIrYbo1Ap88T6F/c++lR47Ufv/MW9kCLllHB1EbSLLQLQdr0Ebr3JhwkFSgzvvZPvAMPHx3DGCkeTQiAkCDHiXeVe4ItSTEg8u6O+/jXDln+ZUyWBkxivhKLW58sN7bS4Z5zl54sUMlGBYd9ZPYv3Hg9weulTo5HjhDAz1r46z/A4BsNITDSNqf9sn8hZ4IucLHBtIZLG3q6001nf5z1En2tjCS6nK6mNtc5I55vjhBg+1n3DCGrvP3JE4+9L5/pE3sPcy+kJoaOxDvgVxi8h3PkOHMtgMBjeUd6p//nSYDAYDAaDwWAwGAwGg2FktMLSHjrwkcolCC08Ich7AaTbuemuW/ceKljL/+VHT24tBeCHAZ7nkc1myRXy2HHNf/jiVUs+cbvzLNX9iNohXF3E0gGhcAmJk0gmuOGjl+lDnfzDvt1dNKUnk4o1IG1Fc2uS6bNakTGLTFMrXb0lvn//kddCnSZf4qtd3UWUVGjpgVAoqbj4oiTlElQrPg3ZDjZt7EL5sOaauWzdtKP4syf4/fkXc/ttd8T2X7E69uHps2ya26q48X5idgkpS2hdIgz70GEvWudRqkBLCyQcOHa4i5iTBBViOWGUfmZpkklFuXCEKe3MWHgBndte3Xvfzx7a/BFUFcd1KJVKOLaNtIZ+pTPC1ztC1ROP6olr70m/4p3D90O0klgiTaXs0dLG77dPscHK48QYbCutQQ6xaRQQCImvoSdfIZWdxLEuj8fXKmbPdUk2ZDiw5xAKqNQ0WHIw+UxE0V4IHSKljSMdhPaZNDUGFr9vOXmyTRo3HjBgYyk9LEXsnUKM8vu7hBYnP0ZkrPMaoU2kqj80VCrdvPD8ho/sfmP/fatW0pmKMaOY6yHpCqTycZTC1mBrkNrmYGcX/d0wb7Ykm7aRsoyU1cGHJasIa+CRY/GSFLfeNnXNLTc17k+nuP3Zp/jPG17cWLziioWUq/DmriO0tE7H90MqFcg2g+UoAu2BZRMKm2JFUizzj1qneeGlcFssnSGebqZtchPtk9I0NDkIoFKGoJpl785+jh/k71evXqJDlSXUWVBxLA0xymRFHwn/EJ/62Kxn7rrz+iXdPd3kC73EE5JiKYeUUCn7fPt767bs7aou/8XPX7bXiTdTq+p6cp+HFlHJ0JP7YTSV8Oykp4nx7093E03sD+dBTp7s76w/H6o0LmUcOe19zDsx+flu0PkOr/dB4svv0H42M37CoBFNDGeDe5mYfHqmIua7TSORTDbAPs5MThvKgFT6YcYW9xqI2nciKZVjXd+jLeskktQMHzzuYeS/y4az5uyexnuWdUys/SbCvYxfwt58fhsMhvMOI6gZDAaDwWAwGAwGg8FgOLsIiSddaiJJjSxWLE2mxSLd6FMuH0bGXRZcfntu635WfPcHz28sFjTxZMCx/t2kJzWR8z1ETLJ82cLLuvbs/LFV7CUZBFihS6iaqYpG9vcepSAqLFqx8E+ferb/rzZuzdWqegrS7cBNt2C5WSrVJK+80s+PHzj+ZAif9sI0pQqb8/lI1kAEoKO0rSlT2ygUoVZSeCXo64LFlzRwpEvywgY2LlnAp266Lvvl2fNaiKUCZLyMdDxAEQQWYdVFeVHCkVAClEIFHq0tKRJx2L0jIGm3Q6gJwwArBsqCZCZOby6PK+CTt81p+/gNjZ/45C1NT3Qdzf1ttVpl0qRJxBOJEaUzIUDKSIyyACmihxBRQlCUElSvcXjG6HEe7zRntn/bsgEHvxLj8Ue2tE2dwZqOqRbIEum04CT5ZlialxaKQz0eMpGgJxfnpw/3bOrqYf6OXd7aAwdDLKsVrZqpVZPYohlBbFC6EbreH8LHsRUQMHlKM/Mu5Pbv/fDVFoRHpVoe1Gk0Iwtqg8liYpTHCOsPTSPTDAmEG2H58P2dsr0Ysr0AJaPHSMcfLqONWwJ0YH+D7T3snAbegOKkISDrzyXw/PodX7n2uuQTV17FJ26/dVZbUwN0HztCJqmxqQ6G2UXJgorDB3LEHGhuacCyNVIPEd6GPzRkGzTpbJ75l6S5/c62L7e08+nHHw9fzfeXWboky5u7oFYVeH4NL4DWDhCOhx8qLDuJUmkKBUV/gc0KmzDgUz+4b8uT27YVKOYzWHYDtsxgMQVLzebw3kzthadzf7Xmyiv+1I3NoCBmkJPTKFlZPGkTKIuYFBx+q++BaZOdy+x0jFhrM1ZDnEN9R7DiNl4g+dF96zYeOcrKeZdelCu5ZexknqbGKvb/Ze+9o+Q67nvPT9UNnbsnIwNDIhEEA5gzCZEUKVKBkGjKgVqLktdP9vPbJ/p4n4Oez5p+Z+0/3gZT8tq7PnueROlJtleJpGRKogI5pEiKFBMAZgIgBxmY2DOd+95btX/c7kno6Z4BBsAArA9OnZm+dSvculXVjb7f+f4YwpKj+M4onp1HWx5C6jCJ+mA3S6eU7YRCs08Cf0z4UF4QPhg34aNmp9XDz8XiSLadufWl7yT340zkQRbOWeoRmt8Hs9YMJ4sHTncHTgL3M11Udx8Lv4b6CMN+NtvrL+bkirT7gKea5PefxLYNp5dtnJnOhouF+1ufclrqMhgMhlOCEagZDAaDwWAwGAwGg8FgOLkIm7JMU5AdFGQXuSDDwGgJ6caoBBbFisBKp7n7d+/1nn+1dM33f9S3s+QHpDJxsvkhHNcGbdOV6eQ37vzQtvd27vkbN/CRGjzh4klJOhMlFg3o63vDLVV45OdPDO1/5rnXefHlXfzbY7v5xZPvHfj+w+///ZN9Q7999TU33PKpe+7MVXxF1cepeVdN6/L4+DgRFyRR3nzjEMKHlUtX86sXdpUrHhvvuL3j1rXndFCpFogn20BAEIBXdahWYvheEuWnIEijdBSFRkiFkB7d3TA+BpWypuIHaAmOHQpz3JhLPgfLlkBnWiD9LN1pzW03rfkPB98/8M3CyH4quaFaOD4JWiI0WAocFf60dKjekLrmnhaeOV00NTPRIM0lb66pUR3NktZYamqieZqlDUuDRCFEFTcSkEhKRke4e/1al7hbwAoU6UgEtIfWAbrmYCY0SK3CcVMu6XSEwUHBI4/0H37rbbb+7ufu3PWLPj726A8Lu0ezNsWKhdIulXIA2sYWVjj+taklRRVhVbAcjdYea9cmybTxG0Egcaw41NrVM7Q/U4ViSjSRDM0UnM0oXxeUNRKP6QaCtGPK19JscsSJ/Pm6szUQtx1DXS8VTCYZhEZfbgCu5ps3Xskf9a6ySMdBMkYyDrkcRCNhhbJmKCikQqDI52HJ0gjFSpmKV0Vho7QbrlUVCsoIkiiVROkoh48U0UjciCKRhG2fXHFL1WPDCy+8X1mzegOOAztefQdfCZSAZHsUK2rjiwDhuGgkhXKJcgUH4fNbv3VNbv3adbf0PTnw24/9276//8lj+w70PTHIyy8d4q033udHj723fzzHIz//6XOuX6k9/9Mu6ChCRYlISf+uA397z7b1d61dtZSq7xPvaGc0N07gSMbKZb7xr7/Y+d6B4Jp7f3eb5/kSFShQWaJ2AVsG4aAKH4Q3xTXt1LqnAUh8IkBcj8+aojpPTOcfien8g1Gd74vqPPXkkkdQbdkOoZPH1NR7cq5o0dDKXeuhU9GJOfLQHM7pP8l9OBPJMjdxz9Y51vfQ8XbEYDgBHmLh3IQWC/dN+f3LnDyBbZZwfTcbv7to7ZAIzYVmzXikSZ4Rtp699NP6/Wcu7n0fVPqY25qbyxj2c/btoQaD4SzHPt0dMBgMBoPBYDAYDAaDwXC24/LFv/oKaH/y0DQhSpa//99+nwgjXHfHSm/g/QPX/PfvPPn63R+/+pxM0kbgo8nglausare569aNX/p/H3nn2c/8+7t/VCaGX8nxN3/2qPuZ3+Rvr7mMz3UvocMCLS2oeBCLwHt7qby3h29/6je3PKOUjaJKPG0RT3Ln8hVOGFtRgNYB6ACvCraEXF6QHYHVK23Gx4Y5cADr0svF0kQUgkqRRKyT8aJHvhqglI/UNmhJqVDGdR0yqRSRWECgS/jKRytIZEA6sPfAXjqXSJAaQZSYY3H06AD5PFy6Jcn4yFHaM3ECoXBjBT52A/c++VT1xzfcuPpbwu4kII5GYmnFjmwWv1wOh3OKA5eQNWlJTfljTY1f2YhZw/u1QB/n30Ae0179tZzhENe6ft2wPggEZNotLKuKpUpcfhWf7G7zCHJVkhqschVt22ihoCZ0UwFELM3YqMdwzkMn1vP0U7tU/15u3LBp5fjPf/4GGzZGvcGh8vW/eOLInls/nEooXaCUVyzpjNf6H0w42AXCRwofS7hUKyW6e9ro7sh/MhNf8k9jecikMviUCLRGN7BQC93vplxrEyFYo3CJ8xGOnWj5udY5FdlQAFU7pl3WnXMZaJegpjRzLEE1t5+3tvd/5tpruPfiCzIgi+BAYWyUTedHePXlCocODRF1oaOth5HRISJRxdHRIhUP2rt7EHaOiqoQj6QIApvcSIVopI2x8WI4p4XCsgWRSBfFvAOyTKo9gZYlLruKpTt34F9w4QgrV3UzMDhIskNhOTA2VqZ7SYpy4KFkmaFsnlVrulixcujOWKz0s1K5THdXimuv2fCv3/zmuwcuuIA7V66CziUQcyXbPh1bO170nz4yUBk5+v7TX/vJ9/jSX/zpb1fj9moSjse//PPX7rzlxu6/2LR2IyOjo6RSUcrjBXxfgIjwrw//6v39A1x7y0cu8A4OH+GNV99BIZGqHxmARRWtPZCiJkwM15cQAq0DAi2mzUMha7/PcZ3PZzdQusJv39GJ0u7kMXnsfJA19eZMIWWVNN95fA9V3GPKED7Ye5DZw10+pZS6LxaL9Tdad3VKpVLTa1ikPEQoXGh07TtYuPCQLWk1fvF4/EGOdRyaSf8CdumMosX4PRiLxe4jdEo6UUwYMMOC02r9x2IxCNf/k6eiP6eALcCa2u97aSHiOdH3l1gsVhep9TH7PvBgLb9/vvXP4f412ze2lEqlZgI2wyJnDu8/9zM532eyJRaLNb3/p/vzVW3/mZWZ//9aYO4D3m9xzhbmJnA1YlCDwXBGYQRqBoPBYDAYDAaDwWAwGE4ydphm/Y63SjZfIuH4yHgHPb1u8fC771339K/efOfGazekErEoSpfoamsjNzzA+evXctOVgw9/71+/t+LDn7p16Bvf+PmybR+n74otnRtWnZPAjSjQrqh6RaRTwYkkuGRcrF3/5uAvn3pq+2cuv/LybwkZ8MwvX+26+nL+oLMrASIXdkUopIaxbAnLssnnCjguLF/ew8s7DuVLVYZS6XSv1ppSscz+gbx6+/3i3v1H2KXhkNAMSk1BayJ+hfUbNo7/xkUXrSbT1Y0lC+hAE09EqAajKEsTz7RRyI+gLU08GmFwMM+5vQCTYj5JlUzM57ILl3J435GvPPGT3f/84Y+267qxlNASS4X9pnas7oolhMBi0pmr5dfsExqNmQKRk2TCP4sm5BjBkp7eh4lrnXFBjWROQkA6GaFYzfKd7/YlrryYm+IRjashLkEGCiUDlAzDsWqhcWTocmfZLu2ZpXz9u7vY+RYf37BuxW4/cCh5PnYkw8rV1tHX3yzc1tWde/ZDN3ZjOXnKXpV4RGPXQ1Hq8H6Ernah51nUFSxfydaHH/lB4tbb7i5oJdC1f3CsIEzUhHf14VKi8f2otzWTRu5o8ys/t/kgWwjR5ketDW0jlYsiGk7kWtjUN3b2y/Wr+PKG1REcXQTtTdz/ZUszvBEZYF8/XHFFiuHhUYJAkXKioMsUylBVVSJOAieaplINUH6U994/wPaX933XjbILqCBIAN1tbSxXmvUr17Bm6fKE7Orq4sLLlvHWO4cPvPHmvu7rb7gscWRokMNHRnAjMJqFzh4X6YBPiTW9SxkeDjh3DX/46MPb/+YTd50/JFH84mfv3nvXx51vXnLFGqLRgKgLVa/MWD4nzt24knJJdfTvzv6JKI1+/Iff+Zebtt2x7cjP+x7v2rI59vAVl56PV/Zoi7dTLeaJpRKoRBs/eeLp/Lv7uO7GD28ojBAhFU0gVSR0E9QKjUIj0bgINFKrKfPjlIfvRIoqUeVPO6ZmWgnOCMGrZigepWa2ze0R4KYmzd9EKMrZytkpzrmP8KHlF6cce5STE27uRMgSCij+qsk5Z+P9WShaiXvm6mKzmOaE4YNFH+HedFeTc7ZyZoT6vW/K7w9watZVXaS2ncZioQzhHrvtFPTF8MHiAeBrs+T1nrpunJH0EzosfrHFeXOhj+afdw0Gg2FRYUJ8GgwGg8FgMBgMBoPBYDjNRBFyBaXqMrRYTbrzfM6/9LrDP/3V+M2P/XIHZcsmEGNgjeFbFrYb55Zrt7hdEf6hq93jhhv46d33bNywZJlNoIvs23+AsudjuQ5CVsgXDpJuC7jssnNY1sM/9nRYdKZhWQ8/vfTyTESTRRIglUBqidA2Q0fKxJwUw8NjxOIQTzsUK7w+OsbfSStBPNGFkAn2HigGTz3FFzasW3L7hnVrPrd+/Zo/Xbd+zV+vX7vqS5vOX3XPazv0Z371/F6ODvh4KoWSGZSM4qZgNO+BHUFaEbQUlCpFULB2bQZpTf/KRgjJyOgIS5fQEYtzxxSp1pRzakmGPy1Aah2GmrTCNBkUcr7MDCo59Xiz/PnWTxMV3fHXXy5VCTyfeJRrbYdIJOIiBVg2WBYgAoRWaCEJlKRYgdESVHSK3XvH2beP/3NJj/zRWH6Isj8ITg5ElXzBI5nguZ8+zl++/VYBy+1kJOsT6FDwBkyoyibDrSrSqQi2RWRsPLhGSA9N0LT/oaBIwkSaZYRE4zQTqSVShyFipyZFgzQP84DZ2tNCTUvHlGvUbi0BoXAUn/De+yjfI5vljlWr7Y5MWwohxcSct4ChoSEuvdQhnoDR0RyB8rBsC78aY3AQoonQxbDiOxQLcSp+Dy+/PMizz1U+s/mCS+5Zs+riL61Zvfmv1/Su+tM1vSs+Z1lLbn91O184MkCQzCzDddsZGvTIjfHg6EjwWjRhEY1DuaRpz6QYGoDAs3EsQeAFjOdGUEGRCy9YHmlL8dPSaB5V9VmylH+86LJlxJJZfH2YkfGj5IsFHDfK6Ogo47kBunss7rhr3YbLr7V+3tEDkVjlH6+6ZrObbnMRWoLno6pZXFHhpz9+ikcfG7/5utuvPzxmr+ag7GRv2aIi3RbiwRnrSqjpqT5HFhFTQ9TOwhbm9rAuQyhkO1tDUd0PtAMfItyCtrE4hUgPEroNzcZi7PNioY/mocK2LEAbWxegDoOhGfef7g4sEFtrP5/i1IbNzRLu72Oz5N/FyVnHRjz8waaZQ1rvqerEGcwDzL5mYWHev8/Wz7cGg+EMZnF9s2AwGAwGg8FgMBgMBoPhg0VNNNHZ2Y5tWfgKfFxKvs2Nt1320r/9wvvceweGUdpjZPQo6Y5OqtUqEb/ItRfFPv3tbzz1/Pkbui9oawuIRqtIGXD4EN53v71v78H9Y4HtdBD4MSpFh9xwEa9I3zf/2wuZ55569ambb+q4JBWTjOfqnbERQRSUy9g4WE6FfB4iUciVK+RLFK+7If2Vl1899P233h5gPO+SynQ6S5dzb+An8b0kyksS+EmqfgKl0mzavOFbv3iCK555buS1994fIZvT5IqQ6YLDQ5AveMTTnVS8gMNHSqzfmEFIgZwSilNpjdaKSqVK7zm9SMntzYa0LoSaOsjzd7aaV5C++VY+OwsaSaUm5tKSatXHdRxsydUXbu5BKjsUptWalAIQGqUEPg4jOagENmPVBE8+l92VauNPlvasQlNBWBUq3hieLlEpa2zb5g+/cPvfPPtM8ZX3+keJpyKUqhAAStYEW1PG3xIBxUKW3tVtxKJc3dWdRmu/YWjPRYFuLoqbycK6qNUQPuCHP4VPoMr0dHN7MhGhVCowcw7mcorunh56eqBShUTSIhp1KRcl+/dCRzdEYlEKRcHRQcXXH3p1548eH79iyyWXfysgRUA8TKqNQLch7QxLl3PvilXrnMFByfadR3jz7aHvbzq/68uer4sDI4eIpyGeipBJdzKWBe3b2EQIArCkh2P7pBKKO27PXLJ7176+b33jjUwiTp9QAhVI0C46iFCuWMHD3x/q3717xLMtn2jCJx4vs3JldPMjP3jkhcuuWnvPmt4VlIoVpLTIFQpE0gmef+VVnnsxd999v3fzi9JNEk21YbkWyUxy3sN9IvfwZH/ZrATouYVcms8DuTWcPeKIRmRZ/M5DWZqHwluIh7RnMw80yZvrWug78W4YDMdNP/D1JvlbT003Tog2JsNsPnAa2t/eot1meceLEQ9/sMkShg1vxJnq6LWNcD/SU1IfjT+H3DePcxtRd5CdjYVwQDWfnwwGw6LDhPg0GAwGg8FgMBgMBoPBcHqof40ryoyNv43jZJEihuc5RCI2iDifumfLQy+++vaNK27e+LnlXe2UigVsrbGl4tot57Nr8OWrguIgytfEEoL+fSMsXRYT//ZoqdjeNu4tW7rJ8ooZ3nxlMPf6awOHR0Y5euv1vL5pc2xlMuVhKZvOTIR4IkopF1ApxXht+0HOWQfxZBE5BNFYjHwpYLxEJdLWRXt3990/f3LPxyVjF1QEA77gZ0rHQduTMhmhCRRIy+Fjn1j30vJVzkX/9sO3Ph9PHPn0pZeL26+8YjPPPvMGb749xMUXrgTp4sarVLwq3Z1dFHI5vGoVoUPxlBJgRxx8P2DpEs5TKhw8jUBrga6P5UT7x2q9popOZnfFqstLFHOTmiywHOWExU1T+lN3fBIQjSZw3CJCsqVczEPGAm2jtQ815y0lBV4gqGoHGUvgeQ6/eHIfBwe5pz2TZHg8hxtzQVRrrSjiyTRSS1y3h4Eh7nnplcKe7p40wq5QURCRAiFrd0qALQWOBViKeAwy7WwpFgc4ZrxnjoM4sYGZTXA08+7NVWrYSsA0s7tNXK5aI0LXNCQTk9oSHpk2NmYyCSx7/Jj+rF7RQWF8nM7OCJ7nUSoFLFvSznPPHiIRh8suvYBfv/w6b73D4++/z7evvvLar27aGKWii6Dy4ABIUBlAkfcPImOR/+XJp3f/MpVweg7s816/6aaNP8SHobGhaqEyRrotylv7y6xaZtPVDq/vOMjGzRKlIJ4U2NqnUh4gHlfccrN1U3dH8Pq7b/HjR/9l7zubL3KXn3f++pRXqfLML3d5e/dQOm8jIhLTOLJKdnwMJQpceAlXXnTJGgaP5nBFFMvxibbFOVwu8aOXjnz16g+v+3oxKGMFVdxynh5ZxilJLEooYU2MU10MqZUGoZET4VQVAgiQii2wkgAAIABJREFUWFPG89h5MX3mzBz/hRcpTl8bYcjZcDI0cfjbOs9G7uf0CAoMkzxE+LC30UNt4wDSnD5CkcDFDfIaHTMYFiMPAp+dJe9M2APqQpCnOH2Cz3ooz0b76E21vGauVwtJ7ylqx3B62c7s7zNbOLNc9rYCDzc4fhPhmu5lUgx2H43Dm95E+HlmrsKwh5g9xPnWOdZxJo2xwWAwGIGawWAwGAwGg8FgMBgMhtONIhqUcUQZqW2EFqggFPNYMkbP0t7Pf+f7O275H+65enU6mkRQJZKMMpIb4Irz0xwdGWf08BCdSzLE4g4Qs+/5rcim13Zk+f/+9YVdIyPkbUGyq5PIjdfGf/+CC5ZRKA8gbEWgwJZJSrmAUlGz8+UBqlW48ZYuRoZHcA4oHDvB6FgOBaRSPQyXK1xw0Xk/RPg/rMooSrs1W5+pIgo9qTHSUQKd4BOfuuyr1erYV194fvcr564dviSegkIOJDFcpwzxKoFSlMtlpJRTqtJIMU0Q0qW1ZuLfPJy3JoQprcrMUBiJmmPRnNuacZ6QtfJqRvlZhFczm6kbJtXbV/XrmLWcnMjVGjwvwIlIOtrZ2JaOg6rUwlwSivkkSKEJtEQpB6wMBwdHef8gD/3OZ+/e8YNHniB0ogvrlLXqtdZoFQrb7r339ve+9+jjf3dosPLHq5fHkaKMsC0cNAi/FoJV4DqgZYC0fdrb2Og4Cq2DsBOnhBNt53jKSyZlTsdRXijQtXCTgJABCLrrjmrMCBvq+R6eFybfU0gJ+WKBigepDBw9PMo77/LKNdds+cjVV69g9+5K6GAmimBVw75qG3ABiKZidEZ69nXqyH9zbJdlKwX5kge6ghWtTTThEwTgBQWuv+4yHv3BywQotlzsEHMTBDLAsSrIhKJU8rn66sjK1cus33/xxWL/L5+sHtn+yhu7cUm6Edbf+VE2LV0BtlRorXBknMOHcvSubCNQZVyrDe1pSqpISSl+/NSv916w5cLfs5wYpUKRiOOCUiREBbTEUQqwUCqYWDshobJVTnt97PpDzlz/00+Yef7MZS5rC1jNcf+YuU9M3T+0CPtRF6YFU36fwSPM/sCvERnCB4F98yhjWHjuB15tcHwr5t604hFOXCQwRrgWZtJ7nH0yGObDdsJQv2sa5J0JLkBbaz8fOI19gFA4s53Ga/l+Fl6g9hSNBXG9C9yOYXHS3yTvTBOoPdAkr/45sb5+mp17MXO/9n5mF5ifCcJcg8FgmDcmxKfBYDAYDAaDwWAwGAyG04OoJS2JV6OkylESFZd41cX1JdIP0H4ZEViM5/nE668dwioVsYM8lhvBchJsWrERxuHAblDVKKl0lHQ79K6L86Hbuoilab/sClbd+ank+g99OLVm/VobWw3QmZCkIxEcGUUESfbuyrLzxQIauPGmBJYsoZWCAJKJFJGYSyLNuQcOH8GyE2g7ibASYMVRloUWFhMhJZEoMZkCYVPxI5RVnFzJ5sgQf39o8CgdPTGGR2A0W8IWNgk3ivZ9vHIFS1pNR06pABUolFKoQNWEUpMn6JqeZ+K1np+QrSVaThfkLWa0JBqJ89Wv/jglJGusiT/XlLX4nlC3i1ICPO1QJcJLO7OlkTx/ZMc6UAQI5YVudcpGKyf8HQ8tSpSrw6TaE4wX+NLO1yrlQimFF6TxAxctLIQQaAEWGte2GBsfp6szhRNhzX//5uPJmQKrY5HTk55nmlYehJII1eq8maE9p76e7dxmdRxv+ToqTMJjQuwmfEAhROhUJyRYtqBcKlOtVvGqiqoHtgsj2TFyFejsbufAkVH27uP/ClSEqu8hrArYJbTtoa0AbVfQTgHtjhJYoygL4pkU8UwU7fgETkCsPc64V6JYZa1jx5CBwgLSCYXtePzGpy5Ae/DSrzz27y6QH4WoHSfmOizpTtHRITl3g+LOT0R7P3l32/rNF7JqxWrat1wFazfFSbdZOHaEVKyL998bolqEpd0bcWSGSCSCtgI8FbD91TfZvbN8l1PqpjhQJeY7RH1J3LOJVlJEqymcwEEGalaBmNJ6WlrshGE+WzrzbQc+N8+qzwQBxNnOdkKxw0x6T3E/zkT6muT1zrGO2R6mz7W8wXCizDYHz5T9+XS6p9XpZ/awgTdx5oyl4cygmQir91R1YgHYSuuwpPW1cx+NhbRTmY+4rG+W43N1QO1vkrd1Hv0wGAyGU4JxUDMYDAaDwWAwGAwGg8Fw+hCAdglUB552QUVRNScpTTV0H1NF7vzkth2Pf/uRL29atfSLyWgoyHLjCQgUa5b28MauASrjEdwOkC44MU1POsFHP+Z0RRwbaYUh9hyvgKpUCLDJ5sbZP6wZzUKlAJ3tsP68FBUvR8SzScRdhKyyd//7bLz0XLoOjG987Ef9K2+/5ZwDEOALi0CIUCtjBWhRc8ICtK4pn7SN0nEK1TjpaJyIEyMRe/uZo0c0K5e2ISkxeGSEtqhL1PWIxywCXQotw0R1ykC5NRGRC5qCVgKNQhG6R/kCtBUWm+omVDMemvCumnAgaxkycqaDWv1o7bho7KQ0WWCW8sfE/mtcXs4Qnoi6s1PdrKr+esZ5E9c+RWSjhcZTAQKWd7SRbGtLoAoVFOBJcOpjJOSE6GXXrn2Mj/MPn//cp4tC2iilkPhTTMDq6pgAVXNS83yHz9x7c/mxHz3xD4cOV/5kbW8UJXyUVNT1hkIKhNY4FkhL0dZGynJYDurdBqNQv6qGY9QKORHi9PjKT+vH8WiWprV/fGJGLUBpiapXJwKmjEchEC6BsFFoJPW1p/GVR+CDF4QpakXJF8uUK5Boa+ON3e+TbucZrDb8agxNEIaNrAv1JuaVQktBdjxHxm5HosgXCthC4ntFXt0xsOq6q+SGTDzG4WFFzIVYDI4c3kPv6tVceflS3nrzCLt3eWTaPDo7ob0TIhGbeCxGPKEolYqsX38u6zb1dgVWkbHCERIpC1sk8YsWA4M+u96CSy8+l1Qkg60dHFtTsRRjuQpv7hn88i2337JDiRgRqmjpE2hF+LWvjRYST2s8FJopbmMT86LRzZ26fhqs/2MsDmeEFJ6xLif2oTmL36afN7ESROigpqac0kJ4+xDhg9OHmNtDPuNUsTjo59iHxL2nvhtnHM1EAls4dWH9DIYToQ+4q8HxDOEenW2Qt1h4iMWzzh5gdhHN/bW8VozNsa3Z7okRwn0waLYmt56qTiwAW+dxbu8Ct93s/XsrrUWv/QvVEYPBYDgVGIGawWAwGAwGg8FgMBgMhtNMnD/8X78K+FNcnCB0S/KBLE99479w9+9uu//7jz/yu791zx3to2OH6GjL4DopVqzcxLu7Bnji8X1cefMKlp7bSSnIgi2xHQcLGzxBpaIZHVfkxyvkCxXKHmQLIG24+BKL9o4MQgT4o6ADl0y6nXT7QXJ5qJTG6GiP0t1Z/rzjlv5LxI6jkVhW2M/x3AhCVBDURGXaBR2FIIEiSrXaztGjApcULz7P4NpedCbRJeLWYVSlitY+WlWRIgyPNzY2hpbguuC6NrliCVumGctLBofYsaIXfFFF4eMLKLmKYIoYbTIkZvhTHCNIm4tj16T4ox7i8xjlyTHCIzXt52T7LZqrMyEwY0b5FsKWFm5uGolt0d3RASooI0SAsjWeDb4ER7kE2mI0WyLeBgOHixRG+XI1P0ZxrIREMVVmpdWU8VM25aJk99ERvMDi5Zd4cO252T85p3c1gR9guaF7XX0MLSGwbfA8j0jERmu/O5/n3WCaIHFyDJghOpyW1wQ5pXwrFkDCdixN2p9re+F1VxgtFmp1+QitiEubfImduUrk+lS6E8ctooNxqlWN0mDbYNkQi0IcKBU1Q8MQjYFtt4GN3rGTwSsud/C9BFpFEKIKQiO1QAe1K1JRhG3R1Z1GCIEdSFLt7eiqh3QKrOjh8xvWxnFklSP7oT0DsYjAki7Z0QPEYjY33LiGwwcHOHiwxIEDkBsHIXySiRxd7R2kEm1U/XGCQFJVPpFYOwifYtGiOpzk8cfeJJ2Gc1f2kraSRF2bwfFDYEf46TMvj9z6ybvv/8a3HyUQNggfiZoSIrMuEgQl1JR1PBWBmDFZJkMBh7dxopyYsUCn1tJgTh6zf8x1H5jRDyGnz5ipOlfVwkYN2K6U2kIoHPjsrC3OeZM6+4jH4ye1/mKxON8i/Q2OtXI1OWuZh/tpltnDhM1VKNJP47GedfwX4fwxLCKOw723ldCybz6Vnej8bDX/ZuT3n1BjDTjB96YHgK81OL5tjuW3z/H+bWcWUWEsFmta8GSv71bj16p/rSiVSk3zF9S9+jQwj/vfECFE0/eek31/Ws2vGe3PJTR83zyaz7Zqf8r+1Kze3nm0Oa/yJ/v9O5/Pn1D5D/Jnc4PhbMcI1AwGg8FgMBgMBoPBYDCcXoQNpGu/N8jXkpIXR1byDOT4n949MPLNlctieMrHFha2jHPB5i08/ovtTz363YPPr1x38J5Mt3susopSoCrQngTlg1eGYhnicViyDDZutkgkXJyIJBoV+J6gFLOxpEOgFOvXp/jZEzkqpSqrly9h2ZK9/+kXP3v+v37sozeVPS0BhZI+Sii0UCBUKJ7QirqiKdAShSSZShO3opTyZDraYqKcH8cVkI7HsVF4XthfKSEaDS+94kG55DMwDPG4xes738uWCvy1Ug665vilZChOq0yJCjohUKtHQpTTX7emrgyrvaoVnPcXxccI5eZ2fuvyMx2cZn+AIlUoDhOaNgGh6FGE4SKDelhI7eL5ICzIZsd4fxfP3L3tqgOWAC/wJ53x0FPa1jUFj6Zc8EglO6j4Dl/4g9sO7Nnz02cGjo5c3xYrYQPxBKA0UoMSAgm1sJQCIWg/ptO6we+za4OOveZG5SfGqnX5E2Yh29diQoAotMTSUC6WKY7xwGuvHvyd5DXdbbYf4NoOkajEcTXSUgSBRzWAahViURetK4wMA9LGcWxx8LCfqZRENpXpIps7MhFyWBEKGsMQsBKBRGgVRoNVUdAQcQSP/fjX0Qsu4n/uXR5leOAAABs3xPGrJSwZICMKJyKpeKNkOizau9rJjVfYs7tI4MHwMBzeP0KgACvUtNrxcH+KuDB8hPcO7eY740Nc/du/c+FNQTUglrYZHRoE2+Odd/o5eMT/jxUt8S1FICcFjmpCMVgXitaFYo2HWM5YPxPbxHzWf5Os494/JsrXmhDh3LaYnOPzCEl6H6ELRauQTIbTTx+NHxL3YlxCWrGdxgK13jmW71+wnhgMx0dfk7ytLfIN03mIUKQ2830vQyhSOxVub72YfeVsp5mD2pngfFhnO/AojcWWAHuZ3H9aidl20FxsO5P+Wv2NPqP2zrGO2QTqcy1vMBgMp4zj89c3GAwGg8FgMBgMBoPBYDhVaJd4ZDm2tZRPfeLz33rmqVd3WSKKUgJFgLRg3Tnnsv6c5ZuvufyaP29PXL72ycervU8/yd+VCjVxloDOTti4Ga6+VnLlNS5r19ukUhrLLuNVCuigiLQ0EUdSLo3jV4t0d7TRmYFnn8gRERFuuGZZsrOD742NHUBSRYoy4KMFBLgERPFEFE+4eFLiSYWyythOFs1+hkef57Kr+M9LlkExdwApoT2TQZJBVZMUxwXDR+HdN+GNHbW0Ew4dgJdeHFLvvxfctvXGDw0GvksQuCg/SuC7KC2mRd3TaroYbebrE2eq090ZQwJA6FCcNiHD0eArRdUPcGw4eriCJXm4WgEhLKQQaB26oKkGKRT/KNAeufwoyWSc99/jkexYgZhr4VchCPVtCCE4JsppaPLVmqnauOOipsDSoT5PqPnWWSvfrG9N65tsf65IDbYGS0lsJYkEEAkgY8e5dMOywf3vctsLTwyqt17L89ZrVd7aWebNnRV+/ZzHu2/C2GDYaiTusXwFSAuU73PuuhXccD1/GU9FyJeyaCeHckdRTpnArRA4Acr1UW4VrAqOKuAGHoFyCISLnVKcs5bvXXERSbs6zt7dms4OWL5iGZYtwvDE+Ajp4bg+6TYbpXMkUj5bLs1w/daVXLQlSe86WLtOsGK5xJZQLsDzz/J3j/+Q3jXLrlx76Zb1f37ttd2bVy5fgS0lSlfQeAS+YM+eA7s+/vEbv1X1yiccxlXp6Wmxownd9VQ90u7ceeCkdMiw0Mz2ULf3VHbiDKVvluNzCXHbChOuz3CqeGqW472nshNnCQ/OcnzrArbR3ySvdwHbMSxedjTJO5PeO+4Dvt7g+BjTnQe3A39M4zC4Ozi+9TXbZ5+51jWbCLB33j0xGAyGk8wZ902iwWAwGAwGg8FgMBgMhg8YQhEEFSrVIuO5LHv3Vf/s6MARALyKD4FiPDvGhrXruna+8sZXopEMn/j4jXtXrmDpRRcu56qrurjqyuWct6mL7p4k8YTEjfpE45BIOqTSEXwFgaoSBGUsS1EuayrVAkPDR7ny8nbyo5DPjrKkM8OtH+q68+D+Pf9k2WMIUUTWQ5PWwnpqomhctJBhyD2RJ+qMURx7gzde/9Xf/sanlvx+V3uUUjHAtiCZsLCEQAWCSllTyIehCTs7YPUqm40bY6xb56JAaI3ja2/CASwMgzp3cYrWc016WposXzumVJhmnDdbffNvv1X5Ge3W+9MoTSrznPovckaQSaUUvq/RxBgdgaOH+ZXrJBkfK5IdG5vSjm74u2MJfL9MKuNQ9YpIyXOjIxrHdimXwfen3wepQ9O3mnGVwwLSQADHdGHZsYqexmWal5d6MrVmevm5lQlR9a8va06ECkk8mSbQgkIJp3sJYuOGZaxenaa93SYaDR0SHTcUZXplGM+WWdqTJOrA4NFDdGZifPrTG/7Hf/7Wd//WDw6BNQJWHmQJJVQtgZJ+uIY1WErhUMQRI3zvO8/903XXJO9cvbyb0aEq+QL0nhOG2CyVc/hBFaWrIHwCXaZSHSOetIglBMIqceToAQJdZOWqDKvWLGHVqhX0rlnCBRduYtVKlnz67o/sVdU0r7yy6ysbN6zqKhVLOK7L+PgIQVDl9dfeYM9u/iwSiZBMxkLxaU1dNpujmNQg1Mz12nzdHrv+ZivfPC1c+TApPSm61fNT3vbN52TDaSNL44e+W09xP85EWoVHbEV/k7y2+XXFYDhujEh14XholuNbF7CN/iZ5vQvYjmHx0swh7UwSqGUJRWofInRTewr4MuE1zNyXHqwd/3rtvEeBz9WOHY9j3Mna94xzsMFgWHSYEJ8Gg8FgMBgMBoPBYDAYFjeiirYGcKIDRBzFv/uD6x7e/sqzB1cuu2pFoMAVLlp7rFjZTfcy+YVAHPiPWAGxDHfFEw653DAR6SJECfBBgBuxAR/P96l6kEhAoAK0CJC2RaYdqhWfiOsgUFx9NTz9xCBbPxTnnOUrca6y/93jT+5YPZbjP9x864V7pC9IJzs5MjBIe3sHlWoJ17UR0sOvjPKzx3avicf4ym0f5hO9q20quYC9e2DVSkimA7xqHunk6V7qsCoaxfcDfN9DAYFUqIrHxZcmRTaX/8+BzH1U1+OHChmGJVQ+cko4z4kQn/UweDOGtJVASM3UMM1iUyQnjuvG5WZpb7bzZnPXmo+gCaaImsLSE7XPJqgKRTAWKrAYOEI5leBtv2oRcd1QFFUbSKlDi7DpoQrDMK9SBDVrsioC3ho+SrlcFdFEPLwuISwsLQiObV83u/aw3blfOzSNeDrrefP9K9a5ttEILeY2B+sOWRUb0CBr5Y6UxtGWYsUm/vLcC5cLN65xECAigEVnV5KqV6RSLVGtQrkIdiLBeefCO7uPsuacNtpTAdu2pf/ihZd/dr4X8MVrr9+y1/MFStvEYmkGBwfxPA8nncZ227GFx89+8MzadWv4hy/9Udvt8aQNOsnzvx7khusgnYwyNHAAdEBHeyLct3QVUbuGQFVAC2zHJtPmUCx4lCvjSFEFK0o8bVFRWVasim6rVAtEIzF6evhCe6dFMppEeRotFZYrGM3mDn36N69+uGpBxauEC1w0CeM5xdnueKJsLqj54nEgpkxOJcK5Wu+T0la4n8xtPvYzewilDyJbCB98biEUHzV7iLy9lvo4NeHatgM3zTh2Jj3kPl00E6j1tsiH5vd2Kwsj8qzPtfq8215rdz7h0AxnN7PNhYXaA+rzr5dQSFLf285GsoQCms/OOH4xrUMvLsSa7F2AOgyLn0bv2XVOhri5jVAg1ks4hx9iYUPW9jG3PaGfUNC2UG02Chs618+sfcx+D3pZmM9uvbW0dUqb/QtUt8Fg+ABhBGoGg8FgMBgMBoPBYDAYFjkKIRW2C2i/7hhW0tpHCIFl2UTcGBFXsGnTavdfHt15+0fuWf54MkXcC0q0d3RAkG/eRE3goAEhA1w3bEppD5syV1/eSzHXz9O/2MuNN9tsXLsa2w4+svfg0Dt73nnt/3nvPb5VKvHih27e4qvSCDFb88rzr1kjI1yyfDmfuf5K/vCiizrdqFOFaonXXhkhGYXNm1dx4Mh+uruixBI2kUiESMRleGh4MqKiECA0Wii0YAMohJAIQnGaJZhQa0wVpxmOoTLt1RTnORUEoB2U74Ji/623XD9qR9Jki8N4gTd5nlSTwiqhQue8CSe70BJN4vPhmy/IDh95fX+55K13BESitSINbo6CCnMX2Jw0hJ57uMQTEaedCDVZJlpMCNjWgwLpQc2xDOGTHRumsztFJBLhyOEKqRQov8zac5ayd99uXt/+DmvPO4fLLl3NhRfLu371/M47nnh8+/8di/HN3Divbr1pbdCTiXHkyAC//uX7tudzxfKl3Hv1FfzB+WvjViYmKRfKPPnUEMt6YMmSDjx/FD/QOA4gwr5M3O4p91dKiWMJHKmpVGuiWMsHEaCkBlGNI6o8+oNf3vbxj3a6XrUI0XDMlfRRSqGximCDluF81FOmj2ZCFFdn6v2az31ezMzQxs6Hfj64ArU2whBV2wgfLmbmUXbqQ8+9hA+DH+T4XELmQh9GoHa87KBxSM8tLOwD/PnSSxhmd6ZQps7eWv5Dp6Q3hsVM/yzHM7QWVc1GG3A/oZhktveArxPOwdnaP1N5hMbrbguTIpxG++tcx7mVMNZw9tNsrmxd4Lbq83bqZ5i7CNfvfQvc1qmklQvdiQhGezmxfW0b4d4487NFXVD3VC2/7wTaMBgMHyCMQM1gMBgMBoPBYDAYDAbD4ka7ELSFAhRKNYUKwyDX1ZVZtm1x4MAhlnR3sW49/+mfv3Vo9JbbQFgWxUKBpCsBpyb28kG5IEHhh0IHMd3VyYlYeNWAoAJCVhkfH+Saq1eD2sdbr+1h6UiWnpU99PZ2WSPZ8T9687WDf1Su2AeLw9t3qYCchsTmtWzovoaVS5bAmt4UQbVCcSzOnv4BqkW48sZlFAp5hADPC4jHXYQlyRXySClQqtYZLWspCqpY1Dpec0yqHReqptaoOyhNVZ/oaT8Wjrql0en2VpoX43VXrqkhPoWoO6hJ0DZoso6VYny8Sqotg+VOmRj1Ya4rfrQOh9YK0AIsqQCN60TIjZNNJdvp7CxT8cYnbsG0kIXhrRpv3fWFVRTVne9mdbJryYn2p3X5CSGgBieoHQOs2mvlQ9Wn6KjwXC3URK2lMgS+j2NLojEYG4dYdIzOzhhXXtHJTx4fJjf2PtfccB6l0iBXXJp2Lzo/+OLgwdIXx7Nqf350z67SEAUHUpeez/plK+0VyWScVUuXYSnJwcPDvPbqCMs74aata8iVD+GrUJwWjYHWAWKqKkwDWiC0jfZt4m4CT5Yo+EWklEhL1iaDREnFdx954dJN58g/3XTehSRdgfBtNB5QCz+KrCps6uvQmuqaqCaHt76FSDn9davRnylgO8YBsUX5k83UeTuPOby1lj6IIqethMKMuxaovjWEDyX/ijD01QMsvFCtf5Z2j1ec8kFitvHpnUPZZg/At867J5M8QGNnmKmsAb5GOFe3cfaJhAwLw1RR1VzZSih8bCVO/izh3Lufs0so+Qhh2OSZouStTI7lfATLM2m2J/eeQL2nk7rTYy+T19BHuEea96Bj6T9F7fRyrDitTl2Eed8p6stC0+z9dy4udK0Ebn3z6s1ku48wuzNbnZuAJwk/E95/HO0YDIYPGEagZjAYDAaDwWAwGAwGg2HR43mamOUCqi4iyvl+gC00oEgkkvQ4knwwxsb1y255o//wv4/FIyMqCDqEDSgdinKEQIuaEES7aFw0HkJPumRJKxSYuC5UfVCBplApEI1abN7cxd7+Ed54e5iR7DBdy6Crq42rL1+HVs6KSrG6IhKJYNmgKCCsErGoZmhkkOEjsHdPnnQa7vjIWnyVYzSXRdgQibk4rkMhXyBf8HBdwtCdgMIm0FECnUSRfYLaMY0dhrLUCkkEpEIIgajJT7TWoZ5KaywgmHitWgrWQkFKk6CPupYnpkpVpstWmoVwnG/IyllqaVL/ZF54zQItGIRJ9y2tNZYKa6nURGNKWaDRlYqH7wtsJ8HA4OFaReH1KTEpBpIcO5ZCQ7XoE3hoy3IZHBwgXXusoLWuCQ+nqWqGj3MAznpCdzCJ1DZCg8RG6to80zYonlQ6elEgdM0+0AetcaMwli8Rizpk2iNk2hWjYx77DhxhyZIl3HrzGna8tpfHH3ubTRfBOb0dlKVPz7plRNzMqsGBsVUqULgRiMZsAlHBiUZ4v383Q0cCju6HSy5IsWVzD543hB94OBGIRMC2pwagrKEt6gJIqSRg4UpJBIXve8honACFxkZqjiYs/uTC8865JRWLURzLEo+mgdq8xUYT3aV1NBwDwtCn9RkVTFkWk25/TJw37UAL6qFtJ8zKavVZcyrdmPm6tykkgUqgiDTMD3QazVCjrF4mncK2cmIP389UthC6nLV6sHgifJHwYfB9LKw7V/8sx4/3IathbkKRhRZezPXh9lQuJnxQvxUT9vODSl+TvPmGC7yPUPg4VzJTzn9onm0tZvo4VqTcaiz7FqDdM02S8OpLAAAgAElEQVQUvoVQYNPIca4usj1bnfZOhP4meQs1B+rvJ80+z32WcN4+tEBtLha20no9nqjAbSaNnOpa8cVaua3H0Z7BYPgAYQRqLUilUk3zlZr/3wyGX0YqtNYTv9dfLzbi8fhpbb9YLB5zTAgR/nWplOEX77XXjcJknAxO9P6daP/n0/7pvn8ng9M9/vOh0fz9oHO61+98WIz7z+nmdK8/8/45d050/zkZ/T+T7l8jPkjz90Q50flzps/fxbj+T/fnn9O9fhby+guFwrzLGBYKRaWaY6h0CPwiP//p02vvuK3tRq01flChqiPELI1PCSGydHbEiDpcmsu6Jcu2saWP7YGjFIFUBJYiCAISyTaKRRcIgDEQBUBR1784jiBwNdqHqAvoIm5MsWFzB8t7FfsPjnDkABTHsgg/SzweI52J4tougZCUShXGx4qUCmUKecjlYcUquOKK9YyXj6JkgY5uQSQSpVrxGc2WCJRCSPAVRCIuFlAsQDRzDk++sJ2RHP8HB3Zj2WmUjqJ1BJAIEjiAQKLVVHewMAzoFGVKQ2bm1oVBLe9M3bVJhPepWZ3H1D+Heus0Pn2KCG3GCdPqFwohLHyfoyNjBFo4lgBkABELLCzKQW1f0TblEqlI1MKJJ6j6HlgSITUaUQvjWTNRU3U3trpoTWLVhH2JRBsRh/RYLk97uw3SR0hBoASB1viBRkZcKr4fDGc50tE5fcBmXs9MUc98Q2zONt714/XxPt7QnfO9n3Npp77P60Cz6+09aGUBPugAxxGUigUSCf73p1/o/+Idt65CSp9oVKKCgECDF0Ap7+HaLpYQ+AHEEpAvjdK1dDmXR5Zx6MgAe/cGDOwbIRGHtnSJRKxAOt2G53lUvTK5kSLDI2N4CioViNnwqW2rEKJKvjqEFgWkA7YdiluF1FhChKtBS7SQ5MY9MpkYCKhWKlCtIn2ftKUp6QBEQOCD5SbJDWMvi/GJazauIygWiDgOOvDxPQ83mmbXG/2883bue+s2JRgrZNERC4vJOSIEE3uYqH3zGxwz3nO70ZacFLuGr+XE/Wu9OzRmvt+kerTx/Z+M4JFrmK8ZQukohA/ftjIpSjtrwnjGYrH5FmkjfHj+xQXvTGMywMPMEl7rOPoPsz+I3dokryGn+/8ni4jeEyw/X6FjG+G9ahRutBUZQiHCllgs1lQ0VyqVjqP6xUOr9XGi/2c7i+ZvnWmhaluM333MT5w2la8B2Xg8Ph/h7TEOjyd7/FvN/ynj08exArW6cKh3AbryFI33iNMqDp/n+899zG2+TDjtxWKxh5qdeLrXX6vrX8D9s79J3qxzYJ735yHm9n7ytVp/+lq9/7e6P63Kzxy/k/gd7/EIzKYyX5Hg8YjT6txEeK/uSyaTTU/M5/PHUb3BYDgbMAI1g8FgMBgMBoPBYDAYDIseITTpdJJKoUIkyp/2nrPWdRyJl/coF0axIiAdRcKJEit7dKTsXW++lkuev8lakfeKJNsctFZorQiofaFsJTh8uMj4+DgbNy4hlJQU0Co0Y0JLLEtQ8XwCD1Tgg87jqzyOFWHD+m56Vyve3zNMrgCVcomh4VIYRq8Wcs8WYXg9y4Zrr1vG8uWd5ApDSBngewGFIhSKJdDh+ZYURCNRpLTxvIBKxafix9i7a4jvPsrvfewj7QfGRiuk0jboSBj+FIkggqDunjb55fikm1qLAZ6SL5mfw1kjwUkzAdKc6p/xPFbRwnmpWf+1wrEdtODISJbDY+PllW0RidYKWwkEEikDlBfGkUxnWP3ss32py6+9JefGY+EfJ0pRmx9h37QO+yO0AiQaiagJ+qRWvPTr51OdbaxKJGOUy1micYlCIpRABVCphoKm4UF9OOJyeNqln3369XmjxeQtVUKCctHaAeETCI+x8XHaOpIM5fIHXnycz2+6sPrV8zb2cvjobno6Y6iggtAKiU3gaxQKFYRCOUtYjI0Nk2nvJJ3ppatzhN3vjKICGBnSDPpZIItlg+uCY4eCr54OQU9PF7G4Q7E0DFQJhAKtsOxwnUsBQligNVKH9xwkS5Z08trOIySisGJJmuzgODELkg5EExEOlSpUPRfbijB0iI4rL+4QulxmeOQQsVSSWNShVK4yPJJj52t7XorErW+WKx5OJI4VdUJHv9r6qIvVlJ5cB1pPd/5r5aA2Nbwq1ISuU15Lps/T+QgUp4rp5oS2CTT4NHzI1Uv4QHkbxyeCORvZytxC2Z0MPsukc91COHHt4Nj7upBOLFs4O8O19dFYKDLXOTGb0GS+PMSJrcs1tTq2LUBfDGcPvXM8bxvHL06r8xDhPtE/x/MfYfE6B/U1yeud5fhCORj2svjdxu7DOO2dCP0nse42QjfY+YQpr6/Fs8WFcy6ffZp9lpmPwK0uLj8RcelnCe/BQjrrGgyGswgjUFsYtrbI72fxfwBbaLYw/U0vy+L6MDCzf3X6OT33qpfm/7nq5/j61apemPsXMXOp61RwquZS/YuqZpyNX2KdbuYy7qeKvjmeN9t+Uqef1uu3l+bray7zfi5j19civ85CXNN82Noiv28B2zoT6KXxfOhn8X2e2Drj9QdpXzTvE3Nja4v8vlPQh9k42Z9Xt7bIP575car350ZtngnjNB8W8v3TcJIplSqkU/Dt7zwZven6nns72tsJqgUsW1IuFymUx4jGbPyqz+F9Y+x8xf+vbT2kR4bHblvXa1HFQ8hQX+EDfgVExOf118fYsDFCqVQhFrMBG4SPViCFhWPF8GWJQFQRFqhaSMhozKZQGMUSETZt6sa2Y1SqJUqlLJWqRwC4jkUi1obruihK5EuD7HjjMLlx6OqWrFi9AtutcPjIEJFYKG6xLRulJYcP5Yi4MXzP4sBAgRdfy/75Rz7c+VWhk3S1J6h4NigXcEEobOGA9mtClQkpFbLmgBSGlZxkvmH2Fp55+ihNEeBAAxHX1Os5Jk9RKpf4/Oc+qp59+rE9laq9kohNOBNCJaHjuvhFD9sJ6O5JJV54KbfxiuvVS0oHRCIRxP/P3ntH13Xdd76fvU+7FRcAAfYCqlPFoCRLsmTJhCUrrrHoNsV2luBkXjzvTSZSknleKStL9OTFk8QzK3Q886as5BmaOHacuEixLXcLktUjS6QsyWoUQbET9QK3nbb3++PcC4AkbgHuBQhQ+K51CN5T9j5n9/3b3/39CYESYjpiXSH/aIHWAiFMJAIhFEKEnBx2L73oIjPpOAa5AggjIvgoEanjxeMOJ8YnyU7x2sc/cbO+/58eAcT0d80m/JypPnY+o1IulZghVWkJWpsobYKQKARmuo1Jz4NkjB3X+l96bN/4uuGc+E8Xbb+ASTdHwshj6QKGDiLPrCak0g6GkQGZYOTEGC+fGAIBXV0xbn7HJlzXpVQoki8UKJU0QlQIaiZtmRRah2idp+R7aBFEqmTlfLINMEyBlCaioi2mJWAilEl23KWzPc7TTxVpf7tGEek2elIipIkXBAhsDrx4CK9AeOllV5vCMAhDl2LBRykLpWzyBc2Ro/x/N759p3ZigknXZ3hsHFNKdNkFrdYROU0QvZ8WkbLbaYpn9RqAOS7Pfr5REqXUi1p++2mefHC+YQ8zLsjOFXYRjZ36aH4MN0TrCWp7iMrObLLWF4hcur0ZUCHlLRR9NDY23s38yATVcMc84nwzoJ0obXcT5WWlHGeJ8nUv5z8hoKeBeyqElmaRKYfTKElyF1H7MtCCuFuNuep9hYjaU+WZVs3De1h+9szZ2MnCxxN7idqnoVa9zApGluqkph4WlkZ9RGk8X7JzBngW+CxRv7/S0QjBrFbf3jOPuPbSGuXDgXK8b3a7+CpWsYo5sEpQax47gQfr3DOnvPl5iHaiyXw/c+/IyhJ1SntZ+gFbOzM7KhvZAfYQMwzvoUV7qxn0U9uAtNCBVL1wAd5JY5P8RsJaCjzE0uxE6gf+ss49n2J5TjhXMhppU5cKjZrR91K7XWmkD+indv1qpNw3knat+qZWT+5a9d4rFbMNjH3UngRmidrs+zh37c9Oov7+zirX9xOVoYGleqFzhD4iNza18GZa6KiG5Va/641XDzEzXm3WiFLv2xsdg83GUrXPjYzr97J802k+aGX/uYpFhcSx40jhsm497163fk1yaqpA3JJYpokQGq1DfD/g1PFRfrHv8Df+7f9x+5M65vP4U4PPb9uSuNI1fSQBSgagBZ2dm3jksSO0r4GNG7sYPnWMRHwNaBshRNmtrAXaxLHTOE4JRORiNgw16JBU2sb3A7xggpI3htIKYWhsJ3KpJ0SI64/jhZpYUpJISsIQghAOHVYcOHiU7rWw7cIMyAIaCHUMdIJi4GM6nbzw0tGRr/wjn9717uQ3/dBEhSE+LhKJkh5Cqznda8qzzlRHKxS7hF580lu996yu4qSw7Yh8OD7BvskJtas7baFVqUwikhhSolQBYfm0tZtkOrjZiYmn816RdDo9Hc5poQqQZWk6ReRKWGqFFAHr1nFzZ5cNsoRtR/drET2ktcD1FCowGRlmn2OnqQWp5+8WcaWiUo6kjghclb8CDyk0SgRIoUB4aO0hUAjp0Hvdu//szz9336u/8ak1/33DmrD7kq1tGFpiaA9BgG3beAEcO3yKQ0MQt2D9Bli7Lk0YukzlhyO3PFKRbjNpbzdQWuH7HkpHdVwaTKsjWhbEZjG2hACJjcBAViqClkhMFCanjg+zpqubru4iL7wwxdU7NxD4LpNuEbeo0TKNabTx9BOvv9IRxxRW7IKR7DCdazrJ5SYo5fPEUwniqTixGP86Fo/9d9f1ccwY8VhwWhk5i5+pT687CyGMLdSdJ5ztRrZFGKD6fOTNiHaiOWIrVK9agV6icWJ/k+Hs42yS0zYWvtA9wNzl5i5mbMfnA2qR+OajotIMWkEOqmCA5bFp+lyij6h8Vmv3MkT1fxdwNctLKKDVaKQM303rVCTnS5LczfK1h1VTR5yrzXhonmHvqxI2LF27s1AMNPHsfEmM5zNqlYEe5tdv9xDlS61xzSFmVNKq2dLvIWo772Zlk3ebVQlutD3soXXj6wxRuu9pUXirWMUqziM0Y19YRYRGBh5vhsHJbqIBxj1U7+wyRBP+fSzdYm0P0UBmnIhs1KihZlf5/oMsb2nmVSweVuv2KlqFniWKp2+J4llF69BD1EcNEe3Uu4P6O5Qy5fu+REQK2cPSGnr2Eu1AqzVZ7SV6v30sH0XExcBqP7Hy0Mh4dVv5+hDnzwLVfNHouP7Nnk6rOAfQWuC6PqmUeXsQ+hx47RDoaN9dJpNBGhK0ZMumrXS02eu9Uh7la44d4h3f/97UswePKcLYJkraId6xkUcePYJXgMuv6KLkjZPJZJjKlgh80MrCkHGksHn1lVEKBY9YLIXjODiOQyxmYtkhTjwklgiIp0I6u2MkkpJMe5K2tgSJhIllgzQV0tB4Xojn+SRSsHmr4IYbO1i/GQ4cgKeezHLkcEB2MkEun+LgGyUODHnq7//x6BefeIZL7/xUzze1FkjhY0gXKQogs0g5DsYoQmYReBGbUmmkBiEEhhBnkVMqqJyfVuyadcwXlWfquvWcvleBqH1EzhGjA1RE/Kp3zH5GqIi8hIreSygKBZfRYZ4YPVUinewiDEFYCfKTJYQQJJNxNC6ZDotEko8VS2NYpsnEePaMsnjGx2lJqeShlSCXz1FyJ3ESfOzyK9Yzmh3BsEFIPUN8VJLurk2cODGFX+JxFTrTrlirpp+WTR1181A3d7QyfENFh6XAUgJLBVjksMQYDhPYepw4BVJGQBKFKBXJ5QSf+cNPfOPJp0Yve+TRiS8+/fNjanhEcOKkpuRmOHbE47GfFThwALZth6uuNuleZ6O1RkoTpQI0PkKGaHyQHk5MkGqzWL8hSTojSKYg3QapNMTjEE+YZDIp1qzppHPNBkp5j1dfKlAqKIISBK4icAMCN0AIQT5forf3AobH4ZF/Ps6R4ZCs305gbuDoCcV37n/9WxMn+Le9Oy7pGjp6iKLyaU+3Y4k4iXgHQhhkOix2Xrfxlh9+/9FLErEupAGppFku/zOuN4U+vT7Pru9y1rVGj3pQ4mwCmtRnk+NahH5WyWmz0U51l461cIhoQ93vEG0IqByfItr0cG/5noXiTppflByscn4h88w91C43d7J8SSXzRbM2glrkpkbC3k1rXcxu48075+gjqgcP0ni7N7BI77Jc0AhRo7/Fce5p8L6HiGx2y5WQNVTl/Fxt6nw3otW6fznbBnfTPPnnDpb3Ny4VWqGUVVE/PEj9cU1FXGSgzn3biDYYD9LifIo2tM0c5wFavW5/N8u3PVzFKlZxDrFKUGsejSw8Zua6TwiBUufFHth+og6+UdnPDBH5a6CZSIWoabxtJ5o4HKR5o9UdRJPAAWZ1pnXirwulVFNhNBv/Skez9adO+rfTmGFvOU84lzWaLf/nGme8/2Cd23sW9WVmUK8sZutcbxiLXP8WPf5lgj1ERt87Wbhs9myCyGITodqJ3veueTzTyxyT/5Wef7PKbiNpvo3z7PtXMPYw//Hqlzhj5/9Kz78G2t9+FpZOA43c3Gzff677n1Wce5SKHsVSiY3r116dSSdBCUxhTRuEw0AghA1INm9e//Yf/uixq1QQ8NEPXjm+45It1/zgR96ehx8/dOL1w5KXX85x8CBccHE3Wnm4pQJCCQwjRqkU4HuayWyBQt5jMgsnjk3heyG+H+L7LmHoIw2FND3sWIhlK+IJizAMCX1BOrmGRLwDU0bSWVrPHIEPgdYMj43T1d3Gu997KZYJ+5/VHHwt5JFHjh+87/7s5376IJfe3Hf1b7/7PdePpdq2gIqViUayTOIKokN6QBCdA6QQy7KsR+4RQ7SK8kspjdJh9UPp6YNZ7knPXAiYXhCYdX/lmZnrIa5bpFT00AEP5qckuSkfFUqCkodpWOgATEtimh6WHbD9Im76xjefvFAaAtOyZsU/x7cJSCQz+H5IOp3m2//04oVbt3GTFllMK1LbquhbaS1QSjA2OsnJ42AYDFpmEpBzuvdcBWXylYfAR4hw2tvr7AMl8FzJrbfeOnbzzTf89qOPcen938l+bt9z7sE3jmie/2VA51q49V3rueTitSihIjVFEUyTImcTqQwjaluOHPEpFAuAno7MMAWO7SCwyOddRoenKGYLDJ/SjI+B5ylyOTc6plwmJ6dwHAPLgsncFG+5Zh1vHIPjo/DyoRI/Hjxw4uGHx/a89epLPtzVQfeG9WvafOViOhLP1ZgihqDS1inWr1tHZ0f77VMTU5FyWjjTN2o13RTMpN8Z6dkKwtiZaolSiOm2Z66jhVio27b7iUhXnyVSfD5fUCGnzWdx/V4iIloP0div4p6scgww4wazh0iN6d4Fvt89NLcYPFTlfN88w6moA9fDnZz/m4z6GrinWaJJI2l4L5HieKMkyP4G7ztf0McMMW2+5NNe3nzpNRs7qU+Q3E/UH9zfYJi7mJ99d7kq6Q9VOT9XGTufVfhmo79F4SzXPF9KNFtmKpslG7U9D5T/7qGxvmQX0abr/vm91opCrTFuK/rvQ0R99700ttaU4fxO71WsYhULxCpBrTm007gB4LSGfbZxZoUzq/tZuH/2O2mB3Pcchq6dRBO4e5oN+wzcSTRA2tmscW12ni8krOW42LCUaLb+NJD+ffMI7nw3XLUczZb/c40FvH8rd43WQr1JRksMC0tQ/xY1/mWAHqK8uIeFE9PORIaIUDLQovDmwn0sbEdhhlkktfMg/yrYKYRoNP/6Kv85j75/paGfhY8L76JsaFzp+ddA+9tPc+P6PY3efC7a/5U+/lgFgMSOJ/jiX31f2qa1XYYhQkWEElFm83guCBy0CNh+4XrsGL9nmwYxaz2G3syuW9/+2ceeYvu3vlF831/9Vfbzm7bZZDosXLdIMpEkCIDQwJQxXNcn8BWG4RAEMDoKruvjui7FkkvR9fH8MHL1KUAaUCqVSKfW8OQTOX728GG8kkkivgbTiFTelCJyJ6lNdBjDtpLEE3FOjAxx2ZUXEPrCf2Qw9+79z3LhB97/rj/6wAdufA21Bml1kc2C0ikgDSqB0gnQMdA2KBswy+m0TEm0IlJBE/p0RTOodlBXYW1aHa18nHXPGeHFbJNUKs2vf+ojJ98YKjwxPjaJVoJCvoht24S+T9wysQxwbLjs0q20t3EPoT/t4lPryH2iFjMEnUg1KiIO2nYMQsG2Ldxz0YUpfH8UU4Jpn9mOCXJTRSbGefxjH7n9VKkYTLsarZAQhT79aBbViH1LteO/orA1l9JWrftCAYGUBMIkFAaBEPgSgsohIJQQMzUqP07MsCjkBO977w2vXX/9NX+07xdc+MAPxt5dDPAvvGwTbxwbJlcCrWNoTJT0kKI0oyymTKSysYwkv3jO49QJaEt1Me3tWYMOLXzPxHMlfsnAc6HkwcQk5IsQc1KosmtPJSSmKZBOQDGYouBPYcbipDLwlX/Ifv6ng+Pve+4Ftu98y3WfLRRsOtp4j+fnUEzhJEwKRY0hU5imiQoBFWfd2s2Ytv71WAJUoCnlPWabeNUSDVMq9WDGxfDZ7c9CVRlr4G4an0cdIlIH6yCy3ewpH32tfaVzhvmS0+4FthON+QbnEc++8jPbWRhRrRnb71CV833zDGcnjZebAVY3ozaLvjrXr2bG5VoPjZWr+RKEVip6WDgxbTb2tOBdVir66ly/l6hN2EPUN7yzwXAbISANzrq3p8FwzzWq2ZMHl/IlzhH6aN2YYHWNqDa5uV6/upvGNkvuJxrbbWdmrWOCqBx/isZIp19iZY4F+xq4p5k8qEfuPVS+526iPnwnjW36qNp2VtvYsggbXFaxilUsM6wS1JrDfAYdfWeeqLh2WMHooXmC2V0scDBQpZPqZ/47B+eDDGWWfbOdpNa6aQWhN3Mn3Wz9qZP+TdXtVdRHs+X/XOOM9x9q4JGlmKQ2Y7iaFxa5/i16/OcQO4kmz4vVR91ZDr/VxvQ9NFe+Mswiz63g/AOm+9/51On+M59fyd+/ArGThZOuKvhLZpEsV3L+1Wh/e2h+XH8PdcZFzY5fz3X/swoP9AToEeDUrONE+Zh9bqSJ49TchxjDNDw6OzEzqWSbiUaGIYbQCKnQ+NMqQq5XJJmy2bVr853f/8HDnyhMFUnGu7FiXXzwQx8qfeij//J7v/O7H/vM/v3eZ1555RTx2GaKeRuJgx8GhGikaSNNi7a2NmIxCAPwffBche9Fv10PXBdKJfA8KBUU2ewUvb0phofh0NBxPE+RSKQxTTAlCBRKa9CSru515As+hhNnLOvyxM/13ne97yM/fNd73qePDfsokcZMdDE+6dG5fjMhJoGIjoj8IgkFaCHRInJxaYgQKXwEAYYOkMwcJqf/rhzTSmxlKIjUpUQQHdI7+6hcm00EO4M4FrnaLMejFegAjTdz6ACtVZUjOOuYUUSr9kyNAw/XzVMqFVA6xmSRr07kQ0rCIueBlgZCaFAlYlaAY7q0pwVXXWH/2re++YMetzQBOgAxTVM6AwpTCkLP5Z++8+OeDev5tY50DDxImxAXFlLL6TwLpGR4rMjRE3xVmjaWIRp2lbloqCmrNYfDx9k+I8/w46iEjI4KSQsTkGUyk0YLzro+fZ820ZhoJPqM1NZlMqBGEiAINAREhKzQLdGeSmJjs75rK24piWVt5gMf+Bf61l+57Yc/f469Y1kXy2pjZDRHRbHOVDOvPv0e2ubll8cYPgWXXmKTnciXyaAWaAetLEZH8hTyJaQ0iSfbsJw0GjBMSHesI57qJJ7qxEl3YiU7kGaC8RxgdfDci8c5cIjP/Ppv3v6ZOz70oe996MMfKVl2N6nEWpJpu80wwQ9KmJaJW1IIGUMLAyEFQRiA9nnb2y675scPfutzTiwkHrcARaghJCJRnknRnE0mi9JfzVwXqvZxWliSUETlOBQQyugeLSMFNQuBrQUxFf01EICDr9vxdBee7qJEF65u/Ah0+2zqW3+DJfqzzIxvzlysa4ULquWAARqbW+5nhhA01ER8Q+Uw3sn8VOh20Zzt7KE5zi3WnBpW1T5agVoL3Pdz9gbKfhpTv+lf4PusFOyhMbd2jWClu0XtW8RnzyRLDBL1GfXQiB2oUrZPs4MtIwzOca4aQa2VCmrLxf1lO1G9GCAaCzxIfULUIRojPWVYOetE7UTv2mr7ca0yU68M7Klz/bNEpLSdRGO7oTOuTxDl626ijQn18qxefPXQx8ohoTaKRvJo9hh6iMb6mbO8i6xiFatYhVn/ljc36riQmc/iZKUR3ldZFKksrqxg/9R7aI36ywBVOvNEIlH1oUq6zVro6qf5Bci6KMf1JQAp5YBpVq9GhULhrHOVvK6Ug/ku1M2+V0pJrfhZOYPihtFs/Wkw/edTt1d3x8wDzZb/c40q7z/UwKN9RApUi4VGyuFgs5EsUf1btPhbiVr9UxX0swR9FGW3molEoo8aCy9z9U9V0KgrlHroFULsAfYsh/yrhwbGH7vnUX57gZ5KW7ESvv88Q9NqvQBCiL1A30rNvwba3wFaM67fm0gkqhqe5hi/N4Rz3f+sogxd4PO/9y8wxQShVIRSMZHPYsRM7HgM24qxdWsPYaAQWmJIAyGM6fxSStPeuYbh4WFefPHFNYVCoWtqamot0CGkjgNJIbQtpZZCCB0q5Wkd5rXWLjBhKTW8Lp46tm2bTMdMadhCYIYhBh5aFglEgGk7BGGBMHTxi0VuuOEKjh078eW9X3j0if/45x8+8N0HH8SVNoZnEjcVWtmfH/yJp8aOH/vPV1y+EWlO4cQ9YqaHaQgKrsfQ4SFyBUimIJ5oYzw7idIQcyAIIfQiuo4ABBLbcSAWsOu2ON97oAjyJBdemKYtkUIKTckvkS+FFNwCx44fAauDkTGfBx8++kq8iz/MBj5FFRDLZMjlc5TGxgjRnMyOceHllyGNsgtPqfnOd7+TVNCGYG1Tyv0AACAASURBVIOpWOso0pY2OoQQaSCZzQWWEJiAIQW+EvhC4AKT0iJrGnIKQ45qwTDaHPEDa+y2227XwhS4Xp5MRwpEgGWb5HJZSqUCQgikNDGwQZtY0sL3Q4pFl/GRUZRSGKYkGYuTn8oyTVwDDh87etpvqSLSUt2iV6n75X+q1d6a5C4R8Nprv2Dtuk28PjTJyQJ/+/NX81/Ydvk23NGjTAUuMctHKbAkxGxNKi258op1HDx4+O/aU97br7piHW7o46Qy5KZKJBMZDMOimCvRnuqiq6sDQpvuTv7uumsvwmQcB1gjTQgsfNOgEGqm/AK5wOHFIa3zIV8+MXIMx2lHUFFRawz13DRqoWa1m2XxvjOemd0UXrBt6+zULAcip39vWLdlOi0RPqFwy8TGiNzYtWYzUtgUiy5C2jh2CqUkWgu0DhkdPs6z+55cMznlrdm4JbM2mw26fI+U55cyvh+0CYUjMCwhhaVFEImlaXwpyKP0lBBq3DSZspz4KWk4x0uBzL79lncUhISpiTHCQFHKF0CHnJqawjTa8H0bHUiUMPjJg/xhZ9fIHR/5yNpLOlImk+PDtMVAmhbJZIZ8aZJYMo1lpHj9wGF++RL09aXoXt/B4SOHceyKm1eF1kWQEChF6OXAdxE6ZDQbufA9cmqcgluMiGJlUp1ptBNLrOPZfad48kn3P7R3Jv7L4IM/R2EitWTnFb1YhkQYdpsTTxAECqF0lH7CRGuFECEIl5ACV/R2M1na9Af3f/vbP//Ep3Z/ww1ZpyTdsXiqe2Qk127HhCOETGqpbSG1AK2kxNOSvBAUE/HEeMF1TxmGOXLbbX2jpmVNu9/VWpEvFEglU4RhgGXFeG7/LzAMG8tyyoTxEB36IAIMBEOvHsTQ4CiBFYKhom8PDCiIFF/8+uMg2hou36fD5mvJbhSqncYUyr9A/YXHQw2GBSxo/rdQ7CXazLuf6Buq2RH2Anc0EN5nab2S0iAzC8QNueEqzwX7FhjfPuYm7PSV36WR/JkvKfFuWjSPgCUtP8sBfXWuD1Y5309EFjkLs8btFSXE8wpCiIW46m0EdwMD53v5m2NeV4t08xBztwd7iMpgrX5hen2vxj2z2+xdwN2JRKKptmQe9ruFom+Oc/tpLZl70VQpGyzffUT1oZF+czb2czqx5r46YVQ8O01jGda/yjtmgP217DdLjEbav0bKUaPku12woPyZ3V5ny+k3NN9Alil66lwfnOPcPiJVyjvrPLubN4/b4FWsYhUNYJWg1hz65nl/P7MWeVe4AkMP9TudykC2nox6ZUfPwHxfQkpZScN+lmbhfza+JKUcYoGkj1YoOEhZ03jdzhIqKi01FlFBYz6y/5Tv3c3iko/OO6x0BZMz3n+wgUf6aQ3JpxoaIagNtSqyc61gswL7z36Wto/qJWqT+loQViMudCo72uv1OXcDe1Zg/p2Jdill7zy/YTflBY7z4PtXEnZSv1w2Ol7dBfQJIQZXcv5VaX97aF069VJnXDRr/D5vnOv+ZxUBppggpkcItcJHsSYN2vSRlochi8ggTtJ20KEin8/z4IOPpwyDXsPkaiHYUShyWRCwVQg2dWSIrynbgyvTGiEjwowQkTtMrWdc1UkF2bFcIa6ZCIKc6VgdoDQGBhoLpUJilg1KYxoWSii8Yo7b33UzE6cGvy2Fd7kQBlJLhAxRocYwknR2pf/L40+OPjP0xsH/dPEO54atW1MkcYgpyWRBo5XB0OECl1xqcWqiiMLEtn2UjCg8YVhx3WmChlAHmKbCdGyuvqbEM/+sWbfWROkiGjcqx6aDacfJuQYnjkzx4EOFh4seu2/edVMwmZsi057GdYtII0QJn5898rPNHZ3Ji/KF/JVhyDY/YIcKWCsF2w2DdjSm1NCeAJMQo5yemfQMIUnriCyiy+kaKvACRYgqqy0FxbBYOvHoQ/cdLbjqhBa81NFpH5sqeC9ozRt9fdcOucUCjh3HiadwHINTJ8ZJxNJIYSC0wolZ+L4HaHL5CZBgSjnjGVGHRBpMQfm3oEw7K+PM+e3pGwaV0oCcVY9Pv16zdVCCeKKNfCHETmTofevV4y++/OxXbpnk43EjRsHPEbPBKKeVJQPGRg7S1b6Zq3udm75y789+68prEv/VTqbxCyWS8QQoQRAoHCP6fyol+N9/87XfuuGtyZvWrXPQJY9kzATLAC0QGEwVCmgrRrakOHqKr7z/g28ZD7Uk0F6tt18S6NPSv1Ipy//XEivmlO8zUEqjhUbpEKUlUoNhSgK3xI9/+JMe32eb57NDSjZJyQ5DsFaFbPZD1psW8fHhCTQRGTDVFqmOGYhIaY+ofGo4zdtrEJZVC6eKlMKi72uyD3z3voNr1yZOFaYKv1zTvubQqaOjz3dnMq9de+31R0xpobVLKCQIxe/+7obg0ceOv+1HPz5139W9iXesbUsTT2QYOXUSLWEybzCRc4k7CZ5+Ft5ypUXHmg0cOXaARCpG4JdZfkIhDRPbMBFS44cBSlkolSbTluP1QwEjWY0XGNPKZQqboOjw8EMHnzx2nD9Yt856MCSGEmWzrJYEPnhK4IaGDJWDgYVX9InbKZTyEYaJaUiE1IQE5IsjXHjxOo4dO/r1//wX973esYHNSmFLnaO7CwxDowiZlYzTf0NgaqqAEpDLhcXv//AHR0tF3jAkL9k2L5oGzwL7r772mnx31wbyuQKJRIZASfzQQ+swUms0QAgDpRRCSgwFppbYGqwyQa0kAcMC2oCuBZfPSIWvIfWFQzRGYBliHgS1JcJOZghfvUSurt7J2TaHfuoTw7KUySkte7uzcTfRYmMjc91dRGPOoQXEU+2ZPhq3ye5jfqTERogoq1gYqqXpIPXzqJfI3n2+qCBWcDeLowrYy/zqyfmCha6H7CVST6+FPuq3C/czQ2L6S6L0X85tyVx96+BSv8Qiop+F22TPtGvUI7ktGhGvhbiPGZtOLzPuz1uBwRaFMxfuKR8Q9RVDs452onLcw+KP7fYw015XlBL7WhR2vXHuYvd9PXWuD1U5v4f6XIG++b3KKlaxivMdqwS1haOP+asM7KZMUJi9uLJCF7lqkSEe4mzZ+N3UVmaoXJ83hBB9LHyQWVls62Eeg5dZ+Xcf0cBhaD6Rzl4cW8giWYOLc+etslez9adO+i8k3VYJavNAs+X/XKPK+++ntjEpQ4t34M5CD/UnAdAiY8gi179Fj/8coLKzfCGoEL96mP8Ee1c53maJkf01rp25G7+9/LvaYklGCLFba30frJj8mwu7Yd7ltw/YuwLL70pHf41r95evzzbw3E0NhWAhRL/WehBWZv7VaH9rtRMLGdf3U2dcdC7a/5U+/lgWEBFhJJSRS0mJFZEvfIFXVCgV0N7TyVOPP3bVwddP/koixm1mwPVOjDVxO1Ic6+wBQ0AqDXEb4okYQNkFnEJIjRASKTVhGM6oryEBk5HjpcTkKRKF0kmUThKiQcUQ2MjAxkmkiRS6HJQMKLglUpk4fbfu2PHlL3/nj9u2rvuTMAApfYTwMYXG9QPWb217MBa33/btB0Zu39rjvre9k8sRdAnF2Mgwz46dYiLeZn822SWteNIkDHwKfkSqsSQgJFKbgIkKwA81hrDZsP4qtmx5haefHmfTtg5i6RT5UomJiYCpQoHDx70nRsf4q+0Xxb8ac7qJmzH2Pbk/qcLita5XuN51uVZKdibiXOSO501TQkcKOjugLQXptvg0ocfAozNlIGWAJSVSyMinKDP1RxPVBVVWSJrMqbK6E2hNvDAV337qVHG7G0CxBPmiR/EkpNvgR9/8+SEnzosCXjYM9iN4TiBfvu6GG/Pr123ALRbwlYu0QBoGxYJCCAMPkGVSj664AC1XYVVRUtMQEaLmUrCvnJOzfotZZ2qq3s+CiSXWUfI12nToXLuB4v5n73n654c+fvtNGxC6gBso4jagwTIhlYBCaZjet2xkZPjgFwcHC4/d8dFLnsnmsnh5H4FBGGgSsU6OHznG97792DXX9PLFHTvWkM8NkbLz2A5gaUCT93w8rTFJ8vTTwwwd5p633mhTLCkcW6KFRJTJXmelgpjPt86NabJiORhV4Q7qiEQVikjRTk03kbNpTYrJUjb6Wc63xx59MglciuAqqen1p17YIWBHIsE2E0inwIlBIg6WE/1NpSGRNBBSYxkGMcskFtPYhph2Hhq1BxKhojOVNntkbBzPh6IPpRDLh65jw3Q5sQL5NO/Pj48SdyA7lQ0e/tmPXhsbY18ywc/T7TyVTMR/3nttb/5d72ofL5amdn3/+0f+9fpufvuCbe7butfGKQqBoAPtGzz26FHaO2BNdw/HT42TSGfIlcaxKgJqWhBiYtkJXFeRL4a4BYFtZjh8+Lj3ysvseePYiY62dnYqQacWjKB48bn9fG/zJudHm7bEyBWncJygzBi1AZMwsHA9RaFgTppmJ6Zoo1RUdHbb5HJ5ko6FMG1CoQm0SaAUmVSK3p1XMjLy/AXbL4VYPCL6dnalCUKPUEekzgo5NERHdVFBwYWiC25A/NQwF7UluCg7ya2j4zA5CSpk9PHBZ55KxPmJbWZ+2NV14S+kNDEdH8PUIPzIXbGyo/ZvHup/i4wBVi55pW+OcwOcvmC4k/o20CyNkShagYHy30bsstObduaJat8xXzWt3cyoxjSCvhpxN4M+Ts/rQVq/qF9rkftcL3DXiv8+6pMvz1IoepOjnj1yL6uu1WZjsMa1+2iMoFavHRvgdBLTIEvXJi8Ec5WfwRbHMdTi8BpFI31mLZzZXg0R2UhWqijEbs62L99DVPbPdfnM0nj/vK18NJMP2QU+13/G7120bs2nHsGxkTzqaSL+Ws/Wcu0+RP2+aKXWmVWsYhWLhFWC2sKxEBLLabuvVriCRrXv38/cBpWKksuzVZ6br7xuxUjZzvyIQVmiScJ9zD3Q7iP6tn7qDIjK8WeYIanNC61QEKqDxVRrOudYRAWNhRLUVjEPrHQFkznef5D6ux33sDi75gYauCfbynjPtYLNCuo/K7LfjU6wDxFNaO/jbONNRaK8n8b7zLvK8S+UQNtDdWLc73D25HuCmb6nmlG5Twhx3wrJvzkhhFhIm38H5Z3eK6j8ng/oq3L+Iebuu/cStZVzupYhKr8rOv+qtL/VxrEPUX1cv5sa6VQt/mb7/nPd/6wiIqeF5SQMVYjnhriui1vy2wOv8C/v/9rBT5by3JxJw7bNsHGLQzIhyHTESSY0MScg0xbDNA3cYgkpIzKOkBFJSZRdVwohUEqhlSZEoYREY+K8ZSMvPn+I4qhHLB0n1AYIB0ND6HpYqRhaajQmUgTEpMHY8Ajd61JcfoX1H58/cPKvEx3rj4OHFh6YJoa0mZr08XD4lV99+49cL/8j25FIA/ySy+btSQjgwQef+oeXDub/bMflfPTiS9tIJjSmDAkAoU00EUEt8qMIoUpw8FCWl14tfSeX558PHR9fc2IM39Nkw4Bng5Af3rJrh9fZmefV19+4YGz0jQ+K4I13CsVN6RRdqSTEumHLZoOSF7J5UwzHUsQcg1QqQcyxMMoEI6kVEg9TFjHEGUrbUiLkLLe2cqYOBEFIWCYfoePosJ2pSZ9YIsmhw8cJlUWhFDA2mkca9rZCwd+Wy+v3TmYhX4TspBoZ/OGjvzAsnnFSPN2xLvNsuq3z5XQ6TSxuo8JIeatCJFNaI3UYuZ6syLlRIU7NENGkEJxNxgqRZSUvdJlkM5/CqzWlMETYcTxVYPzUBG/ZedlrP3nwpS/f0Cs/ua49TcnNYlllFT8Jjg3Fggv+KNfsXMvU1Kmf3v+P+y65+ZaNpxLxDJ6nSDopDKF49cUDay/Yyk/f/54LsMQYccsjYYO0BWiN73sMT0JopTlx0uXA6/zt+3/1sgMTUxonliaX92sSfKRmWo2rcUgoK2jVTx9ZJkpV3iGI/icCKgS1R372+KXA1VJwHYKrheBKBN1CgAVccBFs3xyjVCqxaXMnQeiSTJm0tSWIJy0cS+J6RaTQJFMpbCOODkr4wRhhMIXQwXTxlKFNV2Y76FgUvwg4eHgcy5KYsTRYNpOlLKaT4cDBLIW8oKOjm8lsgVyuaAolLjv4euGykse/yhdhZLw48v3vPfFYOsmD+SL/9I53vPWrxfz4Vx996oDtxLx3D59k50XbycRtrPERRg8f5bp0evwD2y/qZmziKMK0EFYlbUzQNrmCRT4XMDEpKEwpnnn6+a8fO8Lv39LXc6BjbRcTk5PT+aV0gonRk2hp4XkF7FgaLUKE1BAoJAGJmE1QLOKWwlcNaWMSI3AjF7vSiNJAGgZCWEhtMjZyks41nVzYs5lDF71AMq655ZYdTOVPYdkK14sUGwUWUtgooabbVykEiXSKI0eO4yRsJqc8FGnyJclUPqRUEhw4MLWmkOe94xO8NzuaZfzUMz9ra2v7u861ya9l2uMTiLLmXkXlUgiEiJqYSh0SRKRkWWE4N98F9zVwz2CDYQ0y92JZT4PPLwbmWpjcxowCUg+NfV9F2WypMEA0Nqw3T10oQW2wyvn5qmntIxr37mEmn2stmPbUuLYQ7CQaR89FDthPNNdvVb7VskE0EkctO/dQnWd76lyvFX8jednH+UdQu48ZZaBaOERU3waJ0rGSXhNUz/NeFm/D7EpErTI21MDzjawB3cfpaoAZlj9JbTaytH4j/lCLw2sUe5p8vp+z685S9hutRl+V8wO0jshajcBXL/y7WVrvIwtpE3czd1u7h7lt+ecCtTa4N9P+1OufG+m/p7kRq1jFKlaxSlBbOBZKSOnj/GiEqw0o9tR4Zh/wBaovWi+kgxqg8YX/zxINPGp1loPlYw+1VWBmo9VSuK1AH4sjDV4LlUnyYmNoEcNuZ2HplmF1gLWU+Oy5foE5MEj99qJCaN1N68rKAI3tQGm1YWEVjWGAxvqoRtyvTBDlY4UUvZfG8n6AyECykF3SPVXO76f2RH4P1Yne58PO3b4FPldRnVrF0qFan95f45lB4F7mVqZcbm6gWoVqbcmeGs8MUj2dMizchdMqljlyvo+pC9imRSxmU5ocW1vI5e8eHtafdiSdl1wA27bAli1tpJKSRApijiaWUJhGgCRAUoxIEw7AjFqUmGYbzSYmycg9ngCNiRJw8YUd7J8aIZaOY6dSHDxynO2bNkUkNd/FtG2UsFBKgAyJx1NoXG59500cPfHY51XoftJOmuSKBQLDRFoOZtLBU5qS1mDF8NDIADAtir7CQHPLrusPrOve+LG/+PP7brrlHZP/bvMW+aF0u46nkiYdbQmSiTRKmRRyHtnJcQo5N/fTH4z/6e23XftnmAKkZn2pAFZEiHvh+Zc3PvLgL3/DkHzIMrm63YF4Gjauh40bLVJJSccah3TaJN1mYUpFMZ9HooA8BmBaEsuUmIaBQCG1OUPigllKWMz5G8dAC4E0DAwpmMweJbZGoBnlsosNfL9EEEogjdY2+bxLvugzmXXJ5WFkjK58gXdOTvLObAEmRrKMjmRfRvPPaJ5MJdof7e7a8Gw8nmZycgodBIS6QpjSoD1Od9lZyfPTiVqV61KoaX6LnkNNTNRgrIVSoYwcPjkCE5y0Tdxsx/df+nfffuDov/ror643S1NZCglY0xmJz9kGZJJQcgu0xeB9t2/PFKYOPv7Cs8d2vv3t66Yc0yJ08zzyxNOpSy7k8Rvfns7YchzHymNbfqSeJgWqpCj4AswYTnwLPx180f/ly/zW9TeuBSOFF9poIwBMpA6qfwSy5jeejUjFTmtVdp2rI25fxQVsKkYQBPhBgO9LhIohsLClRhg+z+17thfJ26TmRgRvk5pLE0loz0AiCV1dDuk2h1TaImZ4bOg0iRkBWku8cJxU2sJxFE4sROkQKSzcUohpOmQ62zj00gRHjx7l+pt60NLE87Jo7SOEwJIdPPzwy4weB1PA2o2CndclESKP1gEKSLUlSKQ38JPvDDM8Cnd9poPjJ4eJOSnGh3Ns22qSKwRMTkCuQNfEOB+cnOKDoc9f/uQHTz9rWnxz7dq2v1m/oePb2zbrb7clE5jSZNMGgzB0+e4DL/3+DTe6fxRLlVLd65LE3HLC6Yig5pbghedPFHN5vvX8c/y393/g4scuucxGCxifKIK0ZzTodAzTTkVuKg0fYYQIGRKGAb7vUSppLKfID7/7vXeFRfqEBiEFR44co2fbOkxLE4YuUsURwsRAkk50UMr7WNLmop5tHHh1iMAN6e5IokWeMCBiNOpIkc4QkZJf5RD+FBeuS6GVZm3KpCSL+Nog1CZaO2zZFKeQU0xkPYp5g8NvBLeMDU/ecvTA5OfGYvyPWMLee+ElFw+HoUugfUwJAolUZcKx1ggisprRAmZaGUOtCqgGepYgjmroq3K+YkO4j/rzy89ybuYcd1OfoNbMXLCa68c+5mfvGOL0uUB7+dxSzF3nIqdV0Es0vt7J8hhD11JxGWwy7B6qf2O182c+f75hH6e7hayGu5m7vN9Hbc8Ke1j+bibPRF+Naw/VuFYPPU08C43bBPZwOtlmJZHUBhb4XF+Na+fCLt3DAkQxzkAvUZ8xUP49UO3GMvqajG8x0U51W1gv0bdVuz7feOZzvoIBojpyN1FfuBiKW4eI6t8ACyuT1QRBKms+fZxbFd9aaVzxJLYYYS9lGKtYxSrOE6wS1BaGHha+QNXP+bFjpZpBpF7HXmsAPt8Oqo/GBpkLkbavqMBUyAD1DEAVYsHQPOJYTOw5B3EOnaN4W4lmlND6Oc9V65YR9pzrF5gD99GYFPU2ZkiwzfQFPeU4GyVUrhLUlh6N7CCHGSWn+UwS9xH1a3dT3/1Ahqis9c8j/Ar6asRfCxPle85H+e4+5u/ivYJVgtryQJb647V9VDfw93H+7divhsEGrldLpx6Wz7h4FS2ENk0MK4HvFhk/cez/nhpXf+zYpK/YAb1XbKCrbZL2pE8yrbEMHzumMC0fU0auHU/zGAinuTKsph2ldCS6o0WAYUjicQsETBanMGI2R44d48pLLiDwTVwvizDjIOMoBUIbSG2jhY8Ctqzv/MQvfnny8WCU/5nsMIMAgRIQIPB1OO1y0tAmqkye0yi0dFFIvMDh9//gk49NTL722De/+cTa7nXcGo/51ycSI1fYxkg69PFKJd7IF3jIL3H/227aOZIr2tgxA1/5/OzRX2ZiKT5+4ii/lk5y47ou6O6UbNnczto1DrZTIJ3UJJM2phESS4A0fCyzBCIg3lZ2U6uj9Ky495xJw7KTREFEUjuTEzLrtwoVYcRgwbQkWnq0d1iRYhgh8bhJrlACDCBA47FxXRK3ZJAvStxSiGHFKbqaYsEn5wpeOVQgV+DSXI5LC0U+efjQBKXsxEGteLxQ4pHu9fZjgdb7fV8RhpSVlyLyFIAQkeLXDF/tDKLaLKU1oeevJhYKm1CbhFqisXHdBB+8432TTzz0wCdeO1D42pWXb8E2JvFVARkoTDQxR5Q9WpaIJ10+9uEtFzw0ePjpn3z/2Zvf//7Lh7/7gxe7rruBR66/oeuCzg6NZRSwrYC4ExFzAl9T8qAUOEzmTQ6/fooXXuCTH/vorZNh2IUiRqhMDO2htI1BLYJa66AVTE6WCMOyIF0YMHL4QG/oBzf7Qf5mFXJDymB7MgHJNCTjsGVrF04MUkkL21F0dFg4dojtgNQ+FlM4RohhG4BAGz7gAaAUeH6RhJMgvukinnrgKb7wBfiN3wAzZjEylqO9LYHrTVFyQ8ZyJxl8CD68+2K+/tVXuSWjQZTQBqAKaGGipELpArYF37kf7voPLuu7k+TzBdauNxGhhe9DsVCiWBKgkoyOehw7UWR0VF89McXVx45N/skbhycf37jB+tuREf+rt9x07YTyoauzm+vfZv/ZA9977m82b+OOtesn3iENtgI2mik0Lxwa4ikV8tM7PnzDqd6dgtGxPIiISBvxwmYKaES0Dabd3GqlCEMPz/Mo5DD9Ip/6xj9979MmXLthPUxkT7B+/Tr2HT+IF/gEOkAoBYGJbTpoZRCz0pRKOTzPI5PJ0Nnp8OILr3DDLdsJ/SIIj2kxQm0iCJlNABa64vYaHBEgzABHBGhc0D7prTFc16BQMCmVDHa+pZvXXh3l5ZcnOk8e4w/HR7x//0LhhT+54IJNn1dijha83Aad2U41iaEG7tlL/QXCWou0PfN5oSVCH43N/x9iae0lfUTp1UNji/LNbGIYojUEtTMxQTRHa2SDcjPYTf21hKVa4B5q4J5qc/n9DT5fC3dT3X7a38DzPU3Gv1zRT3WyZAUDzL0BcQ+1CWoVctRu3jxz2WroJ0qvuepYf4NhNLJJfYConM9utyv5UG+D6rnGQu3VPVXOV0hBS42+FoXzJWbKTL1+eBtR+i23NaKd1N9EXWlD+puIZ4DmRDOGODvt+spHIyqTZ+ILRP1qxU69ULRTXySgQjTvY+F9eK318UaIubWI9QPze5Wz0EvUh8w15mqnsTWAPlb7oFWsYhVlrBLUFoZmSCy9vLkXbIZaGFYjg+WKy9GFDgoGmZFgrzW4yjCjGHOu0cf5SQpYCjRTt3ez/CYfq1haDNCYUTNDRCq6mxkJ6Eaxs/xcLcPTmTg0zzhW0TwqE9d6uJfm+o2KKmg9CfQ7mdmJ1goMtSiclYhm+om+Vr3EKppCI2PCocV+iRWAQw3ccy53hq5iqaEBIVHS4MTo8EWTY7l7gxI3XbIdrt25jksu3IARjtCZcIgbGtPSSDSIEK01ElHx5hi5cxQR8WyGtjCb3FBRKYrIVkowLfpjSEgkHQwTxifHWbN2EycOHyWbPY5lBUy5Y0jSWNIAZSGUXSY1aUwBV+7Yxmuvnfyvk0V+z9CJv5zMq/9mhFpJR+D5HlK4SA1SpUDbEYGuQvIQJXw1SiKWxlGCj9957SkD/fdSWn9vyiRhYFMqBni+hw4KKGXg5iw2bNzG4M9+sDk7NfLvXZdfNwy6bn+X/+LMoQAAIABJREFURSoesGV9imRM0pYwiTmKZCKOaQSYpiynVQBCo0IdMbJEmWAiItbeWQppFZeZSCqpe+Y9FVJXiCJEIwRYloNhRAppiUQHAPliHlNYEbFQ+AgDTCvENCWxuCAMJH7okfQlQZtJoGDr1g7yBY/8VEihKDnWU6BUYPupk2wvBHz86KgHJq9aFg9JyYPAz4DDlTImKvJgQpXzv1JCphlsp33Lmfy0qh4ytUTpGCpYj9IZQsOOXI8akM+Ncv311//D17721G1rf6vjN9szMSzpE5o+KVtgGQbSNgGX48eOsW5TB+/s23SJ7x599qc/efF7l+7gvVdeaWxauwZM4eGYCseykEIThIqSqymVDApBDE2GL3/l0P/62O4P/4NSG3HDWa5hyYG2UaJ0GnHz9A9unugjBNMqanbM2Oq64c2FPH1BkZttN7ujMwUd3ZBpg40bYyQSmnSbQyIOyUSINANM4WGYCtvSWIbGsiUYKgq47H4VLQgU+L4miH5i2xBvX8f//H+e4jvfhS/8j04uuPlKpl57gUKpiGlYCBxss4B24Dc/vZV7//pVLu+F295/EcXSaxHRS0pCGYCjKaoxLu/dwsTEYb7+969w5//ZB95hDNNDGkVQJYKMQiiDseFJ2hMO27ckCLTDi6+OcellcOQ4N05m/RsNiz956dUX/iYsGl/c2XvtkUDFue09Vw8jc39tGOqvN6zdRKRiF+XDlVdKHMdhcnISKxYnFC6UlR41MiKAicg9qpIB2hpDIafPGaYjZeD9Xxp+L9T0XHMNXLAhTWlCcOzYS+y6uY/nnlMcPXqUru52hAGBr7BkJZ3iuPi4bo62tnY2bNrO08+8xFVvLeIkDAK/nOco0Aolo3gr5csQFcJrlD9WIKN7tEQIjZQBiZgiYws8JTiVO8GWiy02bNvA6CnFK78cTh94Vf3F0IGjd5hW8lPKMV8VQpVrrWR2Da3uvHZR0Es0/x3k7PlPD9GcuhZZaDkq5ja62NtOZGMYOuNoFO2cvrg5+/fs/zdjc+yZ5ztVMFgl3r6Fv8o0lmJM26gaW2WBew8Lt+P01Lk+1MTzjdji65EA7mJGwWY2GlXMOV8VWCaI7EPfqnFPhhlb4mwMUV+BLQM8SERyGCAqZ0Pzf81lgWaIJrOVzGbX/VrE5TPRaBns42zSYYbIhre7HN9Sz6n76ly/l4WVi3aq95/nSqyjr4VhbaPx8cFdzLi03se5IeT0lf/upHGRD4jsx33MjCUGG3hmJ1FZrkfE3jXrvYaoX852EvVHd7PwccddzJDz2jndNXK9uNuZIeDvprHNyr1E3zVA1Ic3Gt/seJtBredbsTY0wNxCMHtaEPYqVrGKNxlWCWoLQ1+Tz1cGKOcjeqg9uOhrUTx91DfQVJTTmh3oDzH3hOJM3MnM4O1c4nwtW0uBviae3caqm883O/Yyv12324iMEl+iPhFgJ9V3DNfDwAKeWUVzuJv6E9f7aQ2peaD8tx5JbQ/zb+OqtWeNhNMzz7hWCvrqXK+lpJih+m6zVSwdthEZmmqND2sZdYZa+jbLF82m0ypWJAIitaOgfMA0rUAATDAxeeSDo6O5f9y0Fvvmt22mZ0McQ09himO0t0ObFSIJgRk3jhWvckKZETmq4uJRz2bhqDKRSqJ1iMCY4TZUWEdCgdLEYjaGhGIhy44LejmcSXFw6HW29qzFsm28wEeIAEM6hIFAhAZamggN3W0pruvdwOtHTm4fzU/+le9zly9Kf2qQ+FJ4mstIhSSI1H8ou5WUJoHSeIGPGyhM00IacRQOJc9EK4ux8XGkMJAihiklz+x/JvXUU0/+se/7d2XacXoug6uuStPepkH7tKenSNoGiVhI3DHKcSrU7KTRKnLreRppqcLaYzqdFKBF5PgyLKetlBX5pArk9L3KtBGxFNJIoqw1mDJBzCjxi+efQYiQq96yAd8di8gtGAil8L2oXAgB0pTEzATCsUAaSAlTuXFSMaDDBuWwfVOMwDcoFkJOjrqcnBQMj7kXnzzhXzw2xr+J5Ol4ypA8rAU/VaZ+FEHOEHKWOlrkL1BoiRYGQs0qD7OT6Uyy3mxKjKi4BFUgPYxy0unQR5oeoYJ33r7t099/4NDmW3eteV9Hu4GTMvCUj2EZmIaJbQZ0d0EuO45lu7z7PZlNt92m/01bW4rJyeOUSiOsaUsSsx0MEeIFAUUfSp6gFMSZyFl8/YFDD3zso9d82jJjjI9OYVhJKJczKIAo57+gCkmtPkFNV9TzZqWBJirHhiYuNTdruBXBrdmT4fXJNGzbCB1JuHxrBylbk0oaxJKKtpSBwAMRIPHo6EogtIvWPmjN1BQYJqDjYKeg81Jwp/ALRym5xegbNEgMQGFKweCPD/LKEPyvL3+YAgf53//vw1x1BVy4ZT2y5GIQYkqD9NoODjx/nKuvg9tuX0+heDgqvuV0UYEmlgK3lOW6m97CW284zOf+FH7tzg2YziS2MYqby2MbJQxDY5iazRuS4AsKbolSUOSqHYJQp3jL5TEOH82zf39hzaljpc/kcty1/xdP7DVj6T+95PIdU6n2TrxiCS06IpeVKKQBwpAEoSbdtoFA+yiyaKlQZWKtrKgZlstqME0QUxj4/S/9wvvjjeu54IoLYeM62LY1wYauNQy9NM7xoVMk0wad7W0ceP0AmzbfjB8UCVSAi0/MiaO1xrIclJ8jcAPWdq4nnXiJwwdPccElbdNppaffI0BQKV8SVXGdW6kmWmJUiMTKR4cRw82QgrgRoz0hsJ0QHbo4pmTd2gtZv3acf35y5O1u8P+z995hlh31nfen6qSb+3b3dJzUE5RHmlZAGamFSAYBQhhezMJ6wOld2+sVZtewXmMPu7aX11E4YO9jMC2wX7ANYoQJEiCpJZQACc0ootwzmtzp5nBC1f5x7p3umem+t+Mk7vd5eu6de86pqlO5fvWt76/4tBSx92r4RiAVvgFaGbXQT7iCGoQbmdezOLUNOKbHPY2wlaUpl5yO2MrR5fVRwnXsNhof7NvNNIlxYEVStnhspTFJaS7UiUejDe7ZNY9whub4fTfzsy/Nxw7/BaaVVAYI18nzrbtnch3fQaj408i2eCvThxVnYjvzI6HU+8eZqLt+y9TSMFr7fRsLOyC7VGRr8Tfb22hWx5p5uNhK2E9sZ5p8O18CykKQYbqeHxv2uwjz+TZmL8+VwK00HhezLP7w/VCDMIcXGeZSMXCS4oXQntLM48Wpivp+xUrgvhnf5zteLxWz9XkzsYvpen9fg/vmizbCPny+e0Tz7fdG5hHW0By/z5d4OkLjvKoTfG+rhdfs0MexOFMJ5i200MIi0CKoLQ7NJvufovFkb4jTn0S0i9kXhLcy90S22UmUhRB7ts/jnqFyudxwch+NRucbX31B8UST+7ZzclXUbuUUWqiXy+WG17U+pWx+QzReiNZl7Bu1/yFaBLUThlKpdLKTcCxGCSf8i1lUzcfVw2IMJVlO//HmdEQzg85umowVzfrPY8avYULDS6O5x/Us/LT6XGPo9TQm5DZanJ7OiksDNB5j64a3RkaIm4EdzeYfzcq/hXljLsP0bKfO60jTuA2PLi1JpyR2M3ub3U7jeX2jfBpZWpJaODlw+b2P/UcMkQNZBhSCGNVqlWjM4rnnHvpgT0/1S72dcMPrO1nVVqItVSFmBSRtC0t4KK+C0h6mZdekmgRH6A8yVB4SQtTcUwahipqaSV9QtcdmEOTqZBshUb7CiZl0pi327smA9ohGHV58dTer165HC4HWgkAIDAuE1BCA1CagkMqlPQFbLkwQ7Wjnnkd2b3rtsP+PmVzuVzpXJX63WjVGopak4mcxRKj8ZkgTqRyEcvjxzhdDhSGZQ0iNFBFAolQFoTVvuuFtuBWPwKvynW998xe0x593tNO3drXJhRd2095eIJXwScQsIk4HWnlhuggAD4WaRSVrhs6cBjCRKhreJ8sh4a9GzipLcNE1QhBYEZNiPpwzpxIRCpMVUukEJa1JrDubYj7KI4/t46XRKb7zjcd5dRf0puG/fgI26SquqmJokIHAFDaWZSCErhFlIBbvgOQqkAFqfB9OxKilNwDKWJbACxRO1CWS1KwXDpWqSSGnyU0ppjJK5qa4cnyMKyfy/M7+DBPa4oGI7X3fcqz7rrj6iudCd4NVtBJYIoltRPGqZRzHQpiQmcqQbk/hBQGju/eEGaFlqNql9ZE1pxKKnU/fOa3JNiObDQ2OgtdfPPD2+743+o3rr7fe0d3ZRSEzSYUqUccnErdoiyeIxxTlaoBnKnREIbRLW8pAaPA8H8Mwqbg+E7kq2jCQZprXDmb50RPZf8/keOdd9/wE9E9q3k1DF7OIUPNuY18nQieOlPWxqlNr166dfh+l0QRE4zF8z8cNFH19fSgkxXKFZLINadjcddfd5xeLpRv8on4DJa5Nx+nu7IR4Cnq3QGeXoGtVgqgjiJkGMdsgGlOgPaThYUoTVKLmltKtCRuGCn6ROLiVCE5qkN3PZvmHP36CEnDTO+HKy9PoaolKxqWzK0Vxcgq0Qe9ai1t+5TJk38XceO0dZMbh6svg23esozL6LLZw0X5AZWKCteva2HSuQ8UbI9Zug59k/ECeaCTA1GBVQHsB2n2WP/2Li7jkiif5k78a4ROf3II/9RIRt4JQ4JoCT0osVUECtgTLkURMgeeWqVAgucZgfYfk8Jji+Rdxdh9wP773wMQv7p948KO/9hu//hW3XOFHj9yPVO50vdImChMpbDB9hFVAGwFCRlCYRCJxCvk8qY4UE2OTXHX1z/Hdu79zfbVQ/LQDV15zEWxcAxvXxensNIh3mNiWT+S8Hg7uzvLanhe55JJB7vjq9xg/PEbv6m7yuTKerpJMGFQqFYTQGELjV1xkJaBNmIw+5XPO1g3owk/R0gUs/MAjCAJMCTEHMA2qObemXFhrE3L6s26q0RoMpVFUiBHHkQaB4eGkBMXyBFsGkyQ7DB7+4SF73+HSnZ7Lhy67aOM/6UpAymrHVBKBT1F2sEwYpTnxoIWfbdTVaoaa3Lee0HZzIsk3K436JnyjA5Cj8whnaI7ft88zHfNd859p+b9cuJXGB/PbCO1Jx9r6dtKc3DYX6nF9iqPJREOLCGspaGO6XmQb3DfSJJydNFdcWjYSThP7zc5oNHrrHHG1EdrxbiXM9zrp4yjEYrGlJG+I0A41HxLJNmZpv/PcPxua4/fbmu3PrSAGTlK8LcwP8x2vVxoZTq79ama/d7LH7/mg3m8tBq1Dri200MIRtAhqC8fNTa7XTys16qTfRXNFglMdO5l9oTSXTHeacJI910R4N/PPjwGaLzI+xfIThXbSnHx4MyevbNO05FSXgmZtu36CrBFBbRstMtDPOm5lZU7dLRbbOL3HmtMR22he/ttY/nLZTvNTx41I5LNhpMG14Vp8o8f8Pkjj05GNwjzVMZ9xYoTmBLUWThxGmH3c/gPCed2xanbp2m9zteH7ly1lpxZGmH1z6L/Uri00n+ajzNDCKQkfgxKWmAJRAhTFwjiJRIz9+195m6GqX4pKeM/N6/Gr+1mVNoibCsdQCGUhRaimpLRB6H9SgjBCtoMSKC1QQejyUykfIQMMS2PagAwgUARKoxQEM8XBxDEKYL5PxDLRgUcQeGzatImx/Qd5ZfcB1m/YiBAQBJpABhjSQhoSpVToFVNpvGoRX+XYfPY6zFQvr+4v8MTThaueeqpwX0Q/9YXA837n7HM2jcejFlorAkVNQ81CEQGlULKEJKi5Zwx5eBqFYWr+9d++ZrbF+QcdsG3TRrjwgl7WrUkA43R1BsQiPo5jgvZQvo9SNWWvmtu/8MWPOchzRB5MIpQM8zAIleo0IcEkkOCZoUqTFB4SA9f3iCTiSA2uFyHRcRY4HRQnpvjGPz7BN78Ld94F1QA2roVfeA/84geupqsnS6XyIqauEaW0RAWSigJhCqSVwCLG9+7awzNP7+H88+HKK/uxIyZSzDhEYofPWzbEA1C6SuBBRwK8DgfD6KCQ02SnPKaKitHDuc4D48G7x8Z5t+d6fPtbDz5p2dwTi3OPY/ODKy+7JqdFqKhWcasEFZ9I1EaYoAP/SP5pUa88+gjTRtZctRpimvila+4uNeBrSLb3cM556p1f/P/3/MWbb9z/0csvXgdmlaKXZ/JwnmgMYsko8XgU3/cJgrpSoIXAwPMCxvNFkAaJttXkq5IHH32Nn+zitiuu6fvoc/sOhPEaHClnWavoYZH7hGa6uqLgMSpxUhMEAZ7noQLCei1NAgSOY+O6Lj94+IFEpaKuzRV4c7HEjckkF0UicM55Nj0RTXebTW9/ivZOB0SWaCTAiQY4lhHGH1QISYEeSAnCBqk4SglL1NMjSHb388j3H+EzfwuPPQcZDRddBm/oXI3O+MQ7kpA5RKAKxHv6eOb+Pfz67z6EiD3Ex/7bOYwfeJ5z+4FyGUMrpNL4yg7JUrLI2ESGrv4NkOygMPoSdiRC4FdwIqBrRa68SXrWnc+b3gZ/83cH+I3/soWYSCJ0vlb+Vo3oGrrIlbWqYUiwbUXMDMmFbTFJMmrS3hVj/bjJAz+c7H15N1/+/Oc++9ZV3T2/GjVwDaGxpIkURhiSlmgZqo+h7WmFSKHIZCaIRCK45Qq5XK7rO9/++qdf2+N9ZPNauOLiNgbPTtMeLZKwKihyJOwkwlQEToBlg++7OI7DunUp9uzZQ/uqNqQUaAKqbhEIyWlaSJQCQxj0dq3hlT2j+AeLkDABHyUVWoIpwJSghUQEBk4sCcoArVFao5SH1gFaK4TUCCEQQiClgaEM8E1MFaCFi2VLDOkRaEHQr7nmmlXc+9A4Bw/zpedfeWXy0osGv+0WwjZm6OMVDpeIHbRILS2cGCznmn10GcNqhkYklPnYymdbs85XPW2+cbTQGLfSWMlnG7Pbn29l/q5ST3U0sqs1q2OjrGweDCzw/uHa51yEuJmKS7uYXoPvZP79UF0JbpBpt4QLETG4naWp/c/Wb5zsQ9PzVXW6kzCvF6Lk2EILK4GljN9DzN5vfob5z0FGWDz5rIUWWmhhQWgR1BaO+ZJY5lIYmxnO8PIk6aSgkUHoC0y7sBolnBjfSuMBdngBcTcrg5Wc/G4nXATO9S51913DKxR/Iwxz6pBiTkfMt203Ol21lYUrFLVwZiFDWJeWQxJ6qViqcaGFxaFZX3I7K0fSmo8Rc6Fy/XcyO8Gn7hLhNsL3SRMuhpud1j2d6+RQk+sjhO/XzM1nI/W5FpYXO5ibWP51ptvjKGH53krjudTpXH8bYYS55/VfJ+wH6vOgIRrPheH0XuO0UCOD1flRUUuyb8/z/bZd/ua6PnjHmzqI6X2kOgK6Oh1EUEb5AdpXuIQqVUqB63kEPqjABmUjcAgJLlYYfs3VnWH4IUnNBGnUSBFS10gSNWIR08QtwzColEtEYw4qKFPIZ+npWMvGzZt4/vkX6ervJxKJoJVAKYVhKKQMOSMSkFKSSqWYKOZIRg1WdQbE26N0dRv0r8ry0nPVD4uAd+185MWPXva6c79o2xZKBgirREhjqhGHpIsyqjVPm/KIR9Ov/Mu/XBJ1+GfD4NzXXy+58IJ+DFUgFfdIp2NI8hhCovxqTYHpWI2sYzCDmIYOcwKpELJ6RGVOSRAIAq0Rsk6+0vj4lMtgOzHisQ6c1Fk8+pjP1+/4CXd+NUOmADbwus3wK/9JcsvPX4sTEajCAcYnXkaogJgDhgIzgEAIKpaJJ0x8V6PcKN+8GzYNwJ/+Odx0035+9VdX1ciNM6pUjbgo669qg8DEc33iCZ+2Tk1nb0C1bDC4dSMHDuY5OJZlPF9mLM9F41NcNDbOR4tZpu4beegHaL5fLHDv22+68pmYE0UpRSabxXGs0EUmChE6V0Qj0IRuThUKU1FzvQhKh/W8TgUMJEx5OZxUJ0Nvaf/tr+3Y9YOSO/YX69ZEBtasThFLxfBVjny5QtH1iFgWQkjqrmE1mnzgEe/ooli2eWo0xxO7pnY/9zK/fdNN592Rr/gEMizSOncu9MtK6EpWAyoWumOsERaVnkFcFApf+5iWTSQaR0qLStnHtqJ89av3n9/VzQ2VKjc6Dtf7io51a6C9E/rXmCB8zhpI0W5qbDyEzCG1TzRu4tga25GAH5LejIBAKWSNRRfgIY+QRGWYnlq1jMQcVLWAHYdLLoNkJ1x5Hbz77X3k9k9QmdzAj374JBdt7aWzey34io4uOG8zmDH4tQ+tI26kMLwMav9LGEqgdAItbDQuplVBSpt//KtXyYy/ys3vbWfNQBt2spPJw/voSLZRymZRJZOIzPCpT76Tb37rG/x/f/Q9/vD3bkSbhxF4iFopazGLs0lDIgywDIHGJGFJzBRYSXhjsp3+F6Z48hl+cfzwoSvTCesDjhn7iRG1MW0TAlDCB+mCqCnNoRHCxRAuyahA+RVee/Xwf8zl/dswaL/5bUnO2thNX4eJwyTRuEciJsFJ4ZcrmERRXoBhQDY3RV/3Ws69YAuPPPIwBw8con/tOnRgUi4Xa4omGsM0UX6AEiZdfWt55uVR9o0dojul0IaH0hAg8DyLiqfwfYH2w/JGK4QwEFJjSAshTURtABBSYBomppSENEgfQ3gIfEzAkRonYhG1LQwj4Ka3refOb+5m6iDf3PmTn6654Oxz9ytRq8tM15tlwDAtgtrpjNGTnYAFYDnXbCPLGNZSMNLk+lwHLhdqR7ifM4MkdbIwQmMPDc32nHZw5ub/fEQORljZcWIx5NXh2mcz1ba6q+a6bS3LdF+UqX0fZNpVXpqlk6puZ2kegYaY3T5wK6f2oeksR3vD2U6YDyvl3rKFFhaLmf3AXNg2x3PbFxBPy1bdQgstnDC0CGoLx1CT6yMzPs90gtpc7oAg3Axs5gp1JoYXcO+2Jte3s7KT3+00nqiejLK9mYXldwtHY4DGG60zJ4HzIZ+2VNR+tjECfJiTu6BdqnGhhcUhTfO+ePsKxj9CY0NwnUS9EJLNbcz9TnVZ7/merrqT02tD4lg0K9sdMz4bGUO3sXADfwuLww7COjwX6WwhbmXqLlzPRAwT9k3LMa8/k/PpZwghhUOiMKRC+OWv5kuIt92yijWrAtIxQbItCsoFw8D3DaqeQcXTlFUV19eUK+BWJFMTLirw0MpHKwOtRM09novCw3YkqbYIqbYYphmQiDvYtiTihEQYiY/GP0LSkZaJ6wZEIhEAAtdj7969nHP+eby6ew+HDh1i/fqwKnueh5QSUxogJVopLMtg7brVTD67l6mxgwxsjjOePUTMFvS2d7F1s8O9393bURjn9mee+Onbu/pSv55sS00kOhyUCFBCYZqSwFAE2kNKFzBrLkurH1GKz3etgtdd4nDBuR141X20p03SiTiWUcareCihQr+mELo7ndWt5xwlIwChCGRAIAwSbecAEbRQWKLE1NTLSCPU4VIKkumziScG+MH9T/K3f/9dHngIvNCrKO9/l8N73nkZl7+unVjHQYrZn1DNVbEsA8cMaEvFcLMlzIDQNSse4wdKHC7A+BjkpqbYtAH6e2z+4PdX09GpELrY5A0EhpRYtoVtC7QoYzqaiAywbYPC+D562yOs7W8nU7YJTJt9hwscOOhTKFntE5Old+4/yDt9D+6/79Gn21Lc67rcYxrcf/lVl2VDF6jTSl9KC+oUNKkJiYSyxguruTYUuq6AB0YsRaEEgUjwjp+/8esPP3jPt55/ufzb3av4jUsGY2u6uuJYpsIyDHxPYEjjSLloJONTil3PHeC1vezbd5C/eXGUv/z5919Yzbo+WtphSuqMuJo63ZH/18KRerouHCGzIUFDNBJjcnKKQ4cOpDKZ8rWex43VKjf29LHVq8JFW0zSScHqtR0kEpq+/gRuMAmyRFebT1DIE7VMHMfCtOMUMpP4LgQ+SCFCSTEpEIaJ0KC0rtMyESpMrJhBMsrlQ9e2l159AVo8w4fW9dG3Lk3Je41Yaj2f/bNH+JcvwxXXvsxf//1W8tn9XHrxWr74+XZiiQSUfkqhtJekq9FVkETQhgRthiRVKYjF2vjs3xRRPtz8XrA7VvPgd3/C4CUXgwPK2INXzCLkOOvPGuBdb4MvfgE+/ltxYqaDgYcKFGgDrY9O/1EwNFIKbBOEcMH2UFKQbu+mp6fEyEjhnHLZe1xECr+inMjnhIgCfkigFW6NhBVD6FCJztQwdmDfqmqRzxaneO9FF5r0r3Y477w+0AXaUwapqIVUZapBAfLg+4TkLymxTSiXyhw8cJCenj42btjInr0H6V8zgLQExXIJ2wTLkAhpogwAG8MRGBEQRpxABwRa1pQfI4xP5vGqUCn7eFVFLlsCXVOB1DVi8IwscRxBMpmkPRHHNCskYoqoI4k6UQQ+UrtIQxMzA7o6NHk1zg03dHH3N8aEX6r8G0JdU292/vJKqI3QIr+czhhd5HMnwy3UyDKGNUpjwtGJwkiT67OtU+9n4Qd1zmSC1IlCM7vCELOXZ6Z2bTtnphLOyDzu2cHK2mQXu+80XPtcSNraOLotLff+zy6Wbj+eq98YXmK4K42bOZ6QM8y068kzUQjidsL3+8uTnZBlwp2E7fFEja27CevNEycovjpGmlxPM3sebGdh/VWGuQ+qt9BCCy0sK1oEtYVhkMYklt1MT2qGaawiMrQ8STqp2M7yTPYXIjPa7FTIidgUG6bxZufQCsd/LNKc+hP+Ux3zUU+rY5jGk/ghWgS1FqbbZKO+YqXQIqedPDTrS04EQWs7jVXUhliYcXmE5dsA2r4MYZwsNCvbXUwv+psZkm+mRVA7UcgQ9sPLYZi/jVP79O9SsZ3lmdef6fn0M4AaOU2DVAHjh1+7SVe46vKt0NcZYKopbAF4HhqTQEUplAV+JUbBNXhp3yH2H/I5fAgCXzE5Brap8dwKhQI4NgFgTCswKaLREqlkiWgM+vvaSMRN2pJRbEuQSiZAVJHnWtQfAAAgAElEQVTCBVGhf20MUSljRxxMAwzbIhpLksvluPrqa7jrru+yefNmbNsmn8+jA4UWAmmEVDdJgO9WCVzIT+bod6ukI2UiEnyrSkpHWHVzmhd+muWHj+n3TRzO3ZDN537l7LaL7owlO0FkkbaBNAzcMjiWQSQSZXLi8P/MTPLJzWvhxqEektES1coB1vTIkCDjZXBdEBihS8AjLjzrLiJrikV1DsdxZA6Fkgo74lCqeuRc6B04i9Fnu/mTP3+AQ1nY9mGDt17fRbUyRqEE6c5ufHcDn/jvd/OlL4HrwVtvhHe8zeLGGy+ls9vELe1FqWco5vL4OsBT4Fc8DAnFfJl4IgVuFapVlOdhK+iPQ38qJE7Fr0kTjbThpEywFcWJSXRNpQxqHl5rJCuBCTqC8iVVHwxDhGQ9BKYEbJue/iTYNr43TkVn8TFY32+zpj+BxqZQiZOZKrFvX5Hxw2zJZdgyWea3KkUyj9z32IOBz73xZOSBzs72x5OpOLlcDsMA0xRg2CEXcKb72BlZrYB8wQYVQUgbV1e4+rpBN2JVPz3yvef+cnKidEvEKr0lmeCadeuim+PxOMlknIMHD2KaJs+/nH+p7PLQi3v4bizBHRdePFDZcmmaqvLRRgWUjdYgtZhWqKr/U3P5GeipkMijAC0xhQVK4LkunucN3n/v42/wAt5QLHJNso101yroXwP9a1J0tjm0WQGJqCAWAcNSmMYU0vaRhkR4JWJOSN5Trke16uKISEjaCmSo7mYajE0VaEtI4ok4thNBVSr4fkCgqrUMC5X7JCGBCQ3lwn7O39oG1iRThQNIU+BWypx7gWDrJZo168GyAyqeRKsKqeghtLsfXJeUlUIEZbBctO8jdBUtg5DwFUjGpw7w2S9EyExUWD/gcOilw/zyh6F/7RP845ffQG+vRFqjaDWFzj/Bp37vHO69+3m+8pW72PaBNqBAoNURl7gzcSxZLVBuWB+kImJDV4dN1S3jODb9vT18/7uHeOnF4B+M3sPrUOL3HTsOKNxKmYrnkVwVw/cFEWXy2ui+dx3ayz90d9B1/ZVw7rlpEkmfqHOYeNTCskoIXUXoalj/a8RJYcgacTVEPJWkUCpx7gXns+/7h3jxhVc5d8vZROMGnlfENBwEFsI02X/gMH1remnvXMtPXxrnoo71ZIomh8d9svki5aKmUPTI5cqU85pKBdyqTxAWKZ5PICRGEIBpglKaVCpHb5dPui1gYIOgq0OQiFtYhkFnbzeqnKXqZZBCEjEVfT1xzt5s8dwz3tXPvfjk28/afO63bCeO58rlVFCDM18hqIXjkW5+y7Iiy/KrntXdL54sF3L3N7k+xPFtKsvi7EvDhOuLM5HgcaKwVPXu7UyXw8kmRi4nRuZxT4Zwv6mZwv/JwDDh/uEO5u+CciWx1Ho2yOxkllPd5tXIu8VOpvd35ppn1PcgBxvcc6ohy7Sq3RCnPwnpw0zvv4xwYoQCbiWsHydamGCkyfW5SKKL2aNsdFB9qWgptLXQQgtH0CKoLQxDTa6PzPi+k8YKY4tRMTnVMEy4SF3KJGw3C9uwbnZibgcnZlNsmLkXOW3MfYpppdLSWvAvDUNNro/M+L6DxgS1dxEazlqbsy0Mc+KNDh+lRZA8mWg2Rg2fgDSM0Hj+MbSIMG9l6acHP8XpvRAdanJ95nxupMm962m5+TyR2E44517KRtAuTm+C5XwwzNLn9btojUGnORR1d2xoqFZK+BX3j9evhbM2RDDVFO1JCyei0UgqnsGBgyVKpRj79mV5aU+Zl/aCq0ArHnVsfigtdlY99hqmcyCxKlLQSgR+4Fka31TKtYuejuRdzh/LcLWA9zzxRLYrEYdUEhw7/Oxoh/7V0NnpUHx5L7Yh8AoeSoBt2UcpUPX29vL8C8+z5YItCCEIAhcpHKRR8y8pfITQqABMbUHgYgIRBQEBkXiRmLSJb02zfkOEb3/vQNf+cXbs2vXkn15w8eDvFCrjpJwopgFCSDKZMhG78nuTGT55xevgssFVVPOHsBLQ1+UgdBWpQ16GBLRQzd16zglJNl8Bw6Z3/TqqhX7e/8F7eXYPOA6s3RTwjv/nfKqv3k8iBdqw+f1P3c3X7oDAgP/9h7fwi++/CLfyAp6/j6lshkQihUkMWxgIDAKlUL6L57oor0IhV0IqiWlYBIZHOm0gZIDhgGkIUAFaTeGW8wQljawR0mp8K4Ja2WjNEWebdSekQaCQMvxFI1DaohpE8SsGTnQ1vWvXUsy9RqgHF6CpYuoMsVWwvidF4EYZO1RmKuOxf385PZXhpqkcN5XLFV556cBL5SoPtLdzXyIhH0ql216N28mwatdE1bQ4nqCEioG2j7gKzWUrJLrSXHHZlqpjyy9vGOj6ssTnc5+7/2whyhdJOR63bYquy5O3/PzlL0zlKwxe2o6SBiWviqu8mivPCGgHtAHKBFF3D2vU2ltYSSKRGK7rUnGLVKt6kym5yq8yVC5zve+yeV0/dHWYtHc42JEqibSgPW3Q1i6ImGUieESExrIMBAohg1DhS81U6JOgNVKHqlnGjDLyhKCjexWJSDd7XzvAIw8d4NKLBekOE9uZdrdb0/1DokG4SKkIpCKwFJFECqlXEVTjvO1tV/L2nwsoe/soZPcjhI8pFUpWMaRNJR/hQK5K/+o1EORB5QA3dCVphInq72tn9doOpGGCe5hUKsV/+GWLv/ucx0VX3cud/9rLDVf1kj/4DMV8kTUbL+ctPwdf/3eXD33IQQegxLSq3lxQImyfipCgqwTY0sVwAhzLIRkVvP0d67j3nj08u0t/MrHBrdp2+x+Vyx6mYdHZmUREDAwFLzz57J+WM/zXjevguisTXHB+J5XqIVZ1Wpi2xjQCAuWDqh5JlwYM20QaxpHysG0LKSW+F+C5PmvXbGDfwb3kizksEwwdoHyJNEyEMGhr7wBho6TDwYNlDnzvp0yWQsXDTB78AALFmFZ8TQU83NMTf9YVuqJN5Upp+CW36HV2pIzJyVwi2Z7s8zxvTc51BydeLl1RqXJl98vQ1Q3nbvJY1R6lHFTRfol02iLZ104yOMxEdoyzzmln/75JDh3mj7Ol3Lfao3G8I73gsqG+ubqNxiqwy4a62+nFQghRU/ETs4Yl5pT3mx+apa9Z/M3Q4PkssEMIMUpoC9vG3OvGXQuOeBonmgCwEnPaer0d5eTYcZvtQcz2zreyuEN2GcK68PVFPNsMzYh2ZwqakTJH5xHGKNP95HbmduE6F06GcmEzzHcvbTtheztZhNBGqLvp3M7JJ9GNLvH52fqNj3Lq27ua9fF1ktogYRsaJPTAU7fzD9fuG+T0UVubeZhwG+G7nAokycVgJjkNFqdOuFDMVBMd5sR6tGrU7w1w/KHcxZLLobmL6aWgtV/aQgstHEGLoLYwLERlCZr7uz/dCWoQvsMIi5vsZ2vPL2RgGmpy/UTl5zCNFxD1yelKYxun/2mHUwHN8nBkxvdRGpM/4PR34dvC8qFudLiVlZXWv5/pUzwtnDzMh0R9IrCDuceoxYzXOwnr12IX+ndy+pN7FjIHnI8k+myuBFpYOdTzezFGw/p89WcB9XxajJGybgBrGZxOc0wTNARTk5MXlQpcmN4Iq3sitKdBGIKSp8mVfDI5zeEJh6efzvPCC1AJ2J1o5/N9nW1f7u1d/VIqlcYyHQzDIfA11YoXbm7L0GkgKO4befBiJCkEbYaGQNTTUROREqBk/c9n7CB0pDQH9+WYmDg+/Zs3b+axxx6jt6eX7u5VFPNZFCZSmxhSgqEQCkwsTOLgFZECrAAsBUKCHfUxzCKGE3DTzb08+MODPPo4/+2Z53ZenSvyQSNSGo3LOFLHqeSLV5dE8L9Wr4ULtvbQmc5gJqG7LYZbLGMbZugK7yjegZrxaRz/EkdhBqFDm7Qluwno4t6v7+d//MFL7DsUXpqsws6nofpagKmjZPJlEo6Pk4SsC5YNH/+fd/CfP34HAN1tsGk9nLXZojMdo79vFR3pGKvXdpJKGXSsMkinNG1tPug86DLgQRAQBCX8YIoKGst0aqSKKiKoohXImTJJWqNq/CsIQmIWHkKKkKinZC0nJC5JvvPQa3z3uyVUAa67JsEH/sM6LHkAGYQEIztlAArL9Mnnxkn0BGzsi3DZ+UkOjuWZKEvGs4qxcTZnp9i8ezcf8SqKwtTUU0JOPWxIHkTxsBK8IjQgamQkDRIDQ0mEVkhRwtA+mgRu3iBmxonFbEoFcByH97zvmhccx3nBcRxy2QJCGAhhEbcTlAoVMCpEIiYSQdW3CUQCtInUMiS/HZFvs8N80BWkwYaD+ypXgjektb46gC2ehFQ7rDsXVqVgTcpiVSJCqi0CEmJxjW0HWHYBVIChTITSSOHX3M5O16DpWldzl1trX/XrgQGBBNNMctd3nmXnj2D8MEwe0vzSr3eQLx3CMsL80kwr0SE0CA8lBFZqLflSAlFaTcIwsWOvUc6+jKM0gV/BjlpoFEqDVjEI+rnpnbv4yP9b4MMfGsQSFSzyYXsJvY3iBVkqZRflafCKECnxu392Gb/wMZP3v+sHfOTDB3nqoR6SyV7GDxwkmNzD0I0RvvKvFZSOIGQCKapo6YM+mqY2kw90lGihNsN6AZjCxzZKGJEqvp7guhvWETH2cmjf1B/++NHJ+7Ze3PdwT38749kpnnr8tQ1taf7JNrj6wq1w1cVt9HcIosY4XX0OSBeUi/YCBDXZNCR6DuJWJBLFNE0qFRdVqbDxrLPZvfc1Xh19mfPP3YxQGj+oYBtRhGEhDfACMCybQgki0bB6eSZ4dde/AgJJWyBIFVRFnXXe+c+kUmkyU1P09fdiGFAo5hFCP6OUorOzg1wuxzPP7Dqr4pXf/+iT/NL+MX/9mv48F1+Yoi0eR9sVvINZEjEHz3ex+hWdvTC6n4vyleKFKSGf0mJZyWkzMcw0yX7FNwrrxKzFELwMwzhC8FLqeMKkYTQbDxoiq5TaybTtaichuWVgRviDWuv0LPEP0Hzut9swjNFj0r+T0D42DGRmpH+YuV1fLXaeuBCSTP3egUXGBeG8dqUOXSynwvNCMdzg2q0cbyu4s8kzzbADeDfh+85nfZFl2oZ2OpA9VhqN6n2WhRGLRpkmK9xc+xvg+PY/wPTeyygnXrmwGW5n/v1InRC6ELXNXYTv3Ky+js4zvEbIELa721gceXC5MLqEZ2/m+Ly9nVP/0Fq9r5kP6vbQRtcHCNvXUO37qUaKrAuEDM/4LcP0vu7p1N/W7XMjs1wbZmXcs9bnBMfW620sfl98Ibifxu10eJbfbm7yTDNsqz0/37nK7tr9p4uaYAsttHAKoEVQmz/SNO9gR475/w6aE9ROd9Qn+yMsbDDO1p5b6ObsQJPrIwsMb4jp0w8LSctOwneYa7IzsMB0LAaDnPoT/tMBzdrhLo6f0DUif9TDHF58klo4w5BheiF4K41PFC8U99fCHlmm8FpYGhrNE07kKd9mfdQQC68zw7XP21hY/b2dU1/avxkGaWygnM24tYPmBLXtS0tWCwvAKGG9H2Zh89XdLN2wczphphF/MfnUIl2eIVBSUSpVcBznFqutyto1KSxLkWpPMpmbolQVjE8qDhxUfPNbHrE4gR2LfjImnT+77g1Xeb52UZ5CBTA5maO3p4ep3Bg/fuzHIpfnRuBNEt6CYGtHO0RioVJaMgJru9tJxWySKQfbCrAjCiHKoUqTqLB5M6TT3eSnDhNPgBYSoUEJHwmkO2Kk22M8/+JTrF33BsolReC7YJhIWVfwqm3Mawkq3FAX9b16E0ytiOCihcKwDa69soO+3iKP/Lh6zViZpz2XD2pH7BBYCKE/m4zCW994Ho54Fceo0t9lUc66JKJt+FUXkCjhgghVxKYja4aQ0CGEwPd8hGnygwcO8OMnDvDKi/CB93Xw+S9NElXwgV8d5C/+bCcf+NCD/PMXr2JNnyZXMfid//52zrvoSR5/8hUefmSCfaPgVSBXhCefgaef9DBlloiZRRqQr4ITgXgK4lE4ayP09cCG9dDbbdLZ0UW6PUZ3fw+d7W142sAwwYkEIfHKUyg/AHzQLr5fwfcq+EEFVAWTEiYeUhkYwkSrAIVES02Ay09fLPHCy/Dys/CD+wu8++cDlPSwfRCBi9QBhglC+KRSFql0hEquSKAq9PRAp2OxxrWplEwqVZvMhEtm0ufg/vyFkxkuzGb5NRkqqO1U8BjwqBI8IeBpTeAK3JAyJCoYUpJKpVGewtOasckcq2P9SGGhLYmwI1jxBKZvY2CgAk2lkANhoRAoVxNgIrUBOhLWVfyQjqSxhWaLpHyJ0FyO4HIZsDXqlEjEBam0QSwR0NEJiTbo7LLpTEbQ2TwJq0w05uNEBKYRhG0DTaBBiwBhWniBh8BEazsk3wkXiV9TPatBgAw9rB5BoQCdCYtHfwheGa6+1mFgwEZ7PlEDdK3qyhqbSwmNRuCToEwHjz2a59+/sYcnf/AsDvC5/7OajatT5CYOkUzEUcpGYRMIk0B1EOs4h5s/tIs/+mt44zsEmzqioPKgIHBDspVPgNZlUIqYAdpxGd33COn+i/jM393CzW+4gx899jxv+LlzWSUF5azL5YMDHD74UzQeWommqoVH3LxKQvadDnNKwhEFRFMErOm1yGTybDm/j72j+zj7LPNv49HYxeWSR7WYuzlp8c8RTezG6+Kcf3YXhn+AZFzhWB66GvYvQoScPilUjSZY/1PTfYMOlSFt20FKiVI+nhfQ3uEwsHEzP3nycTYNbCAuBRqF57toQ5IvZbGEjafKtHfB1W88m1xxgsMTFXK5gGJJUygGXZmc/wulAr9Q9QIee/wpSkV2xuPcMz7+2l3VavWeq6++QperVQwzwtjkJJZjccW1173Ynk7+r6/+y1c/nSvxsaee5Q/37NlnXHNlO5utdgrVCfq7LPrSUV7dk2FgNTz/IuSK+VtSxdxTylzxvc9hptcrQ4Q2udE57r2ZxmulOwnXSkfNa7TWSyKoKaXQWh/5nAduo/l87HbCNcVoszAXEf9in99JqJ4926bmYueKQ3P8/lFqBLlZ7h2msV1uiLCezEYK2cbKHrqYL+Gu7p6rUVrShOvtZnsWn2kQziDHr01vZ5p4Mdok7EbYUfsbYlqNKM20ovgo0+2tXj9GaPw+S0nP6YSBBteWsu6ql8lsqJdPPf7tS4hnIRhgfram7QsMt76+HWCalDdY+8wQ1qU6oWVkRhzNSBmjC0xHs7C21b4PEaZviPntRS4HRhb53ADH97G3s3jVphOJ5bZb1InHx+7TDS1zPIvFyBy/1wnBy2nLmWvuMpeq3hBHt79m2EnjMbE+bi2E2F5PB8ANC4iz3r9sY3H5N8DS+73Zxv8Pszz7RNsJ01fvO4eYPvxQH7NHan/1/Gk2wVyOdLXQQgtnCFoEtfljPiSWYweqHTQmMbXFYrH6gmxWlEqleSdwJVAulxtej0ajEL53fTF7K80H1c/U7s3MM/yZGGhw+3FlMMvzdQxy/Cbl/SxM0W0ncy8UFjoJWijSnAauPZfqAmGpiMVi87mtWdsemeW3YRobNN81n/hPdvueZ/4sGs3a9+mORfRfo4R95K1Mn1gcYuFKNXVJ6R00MIosIn2nFZq5QFnq+61A/R2Z+Z8Vbv/NFsbpJtfnwjDhe9xGc3WC3YR1fS7D5+mEoSbXZ3vHkUYPCCG2snRj/4qhwfgwsgLRHTdZmMf49CkWbpzeSViW9X640Rxq5gnJldycOilo0r+NRqPRIeafT8PU5vXzDH/J/XOT+rGYAxzz6ROP1NN4PD7fcGetp8Vicb7PnxT0r+tj7+ghItEYk4fzlycdSK0ysWMG+aoir23GS4JXdns8MOLiRHhU4nwIzJeEUaVSzVCtlknFO9FA0rb53r9/+4JqmQ9WXd7flmSgLQ3dXdDWBj0dgs6OCJ2dDo4t0b7GMDyE4SENQleFUoKwEUgsOyCabqPsHkYpKFcDojZEYwYqqJCbynDw8ATpNshk9oIw8X2NED4IQeAHBEpR9jyiSRNUSEoJRKieFpJTwDAlcVNCOcPqpCS9KaDNhsdfIP7SXr6ezxf/c1sq+lnD0FtW90AHU8RNlw7bxi0oTGL4nkQIC0QARo0HdCw37Siy2rSimqpNc+xEG36hQNWHXKZKpQpveTNs+s0NRFafy3XX/wjDirLl2o1csvEF/tNvljjvskd481vh9TdcwLWvN7jllmv44IeuwvUzKJXjhZ8+y1NPvMCB3XBoL0yNwYHX4PAk5DQUBVQLMJGFl3aH6Yg4hAQn9wBCgBMF2wnJa6u6Yd36GF1dnbSn0ySTcTo6UySTgv41KUrVcbp64iTsHJWxR4kpEF6AEbVQyg/Vt1CYospNb4at54EMYE1/Gh3k8JSB0j6i5o5SKhNRsUEKAgJcDbGURSxiUEVh5AvEnCSe69KRNPBX25y1waKQ8yjkNKWCZjKrByvVYHD3oeovexpcxcEAnnn44Xue0pKdUvMS8Pxb3/SWcUPYGDJGlA4KShGUqiAU+UIRq+JTKJSIRGIIIehYu45qtUqpWiLwFbY0uPuu760ql6vn2KbYZAR60ICLDM35hqavIwXJOLSnIZGA9g5BR3uC9vYkpu0izDyWHWBZFqYMcLojCBTgo1WApxVahyQqADveTqnkop0E8c71PPfYa7zw9DjXX9VFOqXRfhaEjxIglQ47tpqSnAIMCYHn8YsfOZ//8bvPsumsKpdcuh6yr6GrYEYkSoCpwJeKUgAqmiTZdSN/+uff4I8/ExCPQiULSeBjH9/H1//tzVipXcjOVTz18Dhf/sohfu233siq/jW4Voxr33U9f/XV+3l1YpzN/RbCk2hX4fsG990d8Ma3rCIR86kWM9imxC8pbBuk57FxwwZiKTgwWYGyZvS5Ev09/Wzsi3LLW+KYOovWFQQKGdJDj5JN0zO/1BTnjjRUPaNtKjAFpC3wZJ6erghbL4xwzz2VLZ73shS2+RtTE/5fbTkHXncpbNpgYVmHSXaaGFSody1C1tQERV3DTh3pB5RQVKsKOxHl0Msl8nkIlMXBscNEIjaxWISxsUPs33eAahn2781y3sZutHKp+i5KBXSvSeDhUt2TwYlAIlYgkayyutsCHIq5Mp5rUq1GcV2L3Qfy5M8OyGXVYLHI4N7R7McqJUa/+S/3fyWe5Etv+rkbnjVicQI0pWyeR0buIxYxPeGoT0stv5ad8L90z/enrsgWO7j0wtVkDuwm1WeR1oLuuCAeVRzKqCvXDoDWwQJGotnRbPycMT6PNLhtkLk3z+/kGHeGMwlZ9fXnbOpnc6F+r9b6iEKaUgop56UoN0Q4z5pr3XWUe6vZ7G9LjH8pz9/G7PPIxa5DZzvwdKx7rzpG5hnmzPvq9hkI037cenoZ7Q9p5qf0txCixw7CvJjrkPwuGq+dhjm6rOpxD9Sea5qOedhPRmhQNsfk30CTsEabRXaGYKDBtZGZ/1lG+9KstqRm6/Nm5d9sf6BW/nWyw1zrz08xR9k3i7/mgnjONeIC16fHuSpu9n4LKJ8Rpm1uR1DbP5yt/6zvKw4CfznfSGZgFyx6/T7M7P3GcTiJ+0NzecA5at9uBe2zIysV8EwscX9nlCb2k2b5c0z8A8de11rvbhTHCtjfM5w4IlSdnDgnmpTPDhoLv3yGud/lWHJ5lnC+NDzzpiXW74wQYrjRDTP6h6F5hDe6lMS00EILZxZaBLX5Y6jJ9bk2YHfQWEVtG6e/skgd25mWJB7i6MlenVW9g6Vt9A00uDZfpnq6lo5jJ6jXM32qaz4YYW6C2mKNLvPFXKcRjsWHWVnf62cChppcn61t72R+bj7PBGJGCyuDOsEMpo1+jcaKXSz+RE4LJwbNiMknsuwyNO6jBll8/zTK9Ompm5k+fVrHSC3sM6muLobIPErYbhuN1Tdz+imhnu5y7RmOPgU4yMrMV093nM75lOb0r6cnFRNTWWKJJEGxQq6gz+rtANPUuJ6mkofxgsXzr2R58AFIJvg3UybfZwgbYYfqPwKFZZgEnsfI9x642CvyO5Uy71+zBvr7Yd36BIm4pKM9SiouMVSeqOMTsYsIqVCODDliNZ+YQgjQIBCAojDl4qgy+XHYvKGfmBPBcWxUkOXw+B4efnAv73j7ubzwwgscOrybnu4NIBRa+2gtCBR4gY8bQDyhCdBoLUO3hzV3j9RU2QQ+UUMTkQFJGywDkqs60I9O8vKo/uucP/ZLBpQ7k2aiMxkhqCgMHbpPRPhhhuppxTRNjRuja5JMR/kUPJ7woAJFcWISAMOS9PY6rFlvobWmWN3L1CuvcuEFbQjyZF+5k7e96Twe+MEAn//i97n/gQoPPPAMhvEMySRs3AybzoKrr4OBTQO8931vxqYNy+xCly2qZYOKZ/HqZIFD4wX27TnIxFievfvHmZrMc+jgOJkJj72vhEmtlKBShnwWXnwJHn64hBYltHgtFKarva9lhu5Fz78Abnmnybb3XIuT9FG7XwDfRSoFUiEAQ/hcenEnl74uHipIuQH5sfEj+amlBi0R0gQBvlKISJyIk6ToVnn2Rxk2bo7S3d2DX3VRWlMqVvA8TTpuE3QmwLcoFQSuZ2JYEfYf3E+uXCaTqfbmSrp3osyNhSoUcuC6VL717bt3S8mewGNvAHuSCSaVYIJwA6BqWcIvFLQZjeAIQZvnsypw6fAD1gGrLZP1lQrr0kkitgWJGCQi0J6AZBTW9aeIOQHxmCDiKEwLDFthWUWE9EFWMQwwzJqil1aoI5t8x2z2aYOx/ZPgOLS3r+Kr//oEzzwBucMwtn+MX/7dLai92SO+OdWxXAstiFqSqfEcd333EB//RDtbL+2D3EEwJLYdAa2RoX9OTCTKC+hct5U/uW0Hf/XXmnXr4O1vuYi773iS3BiM7odX9gl6es8BsxOnfRP/9PVv8IU7vs/aAShVIVOAK6+E1wxcp0IAACAASURBVF9zDiL7k7AfMUHqJDvuzHDWuTZnD0ZxzDKF/VWUAR0DfVjOOfzv7X9PsQzrz+mkGrjs2JGlryvLNddbrDlrFZ43SaC9Gjmt/sJzEWvq6mW1/4rp71oAWhIxHFKOQFUN3GqFrg4qWvL4oXF/8MLz4ZpLoKcLbJGhsz2B7xdB6COtWxwJVx4fL5BIOOBpDh+aolyE1atXH7ln/8E97Nz5HOect5FzL7qcJ5/YyebVSRxpIlRAgI9fKROJW2Qmp9h0dhSTEugSBgpDQCoFgQK3Iql6Nl3tKcquSbGkqZYNDq4tsH9/fmDvfj5R8fjEd75131faOuSfXHvdG57AjiC0BE3oQhb5YjyZutL3/H995NHJ91rK57rBbkq5En5F09fTheMcxjDZVCoUcRKa2fq5E4xB5iY/zEV2OoL6BvtCCGozn/N9HyklQTBvsl6G0AZwG0fbCu4knKcdtd6aK11LiH8pz2eYVkWp53fdk8ZCsZ3j17WfYXm9Fsy0z6w05rMHcCezEz3q5LnhWa7V7z/WrrSLMN/nmrPPtC8fu7k9yrRqykiD9C43mh3iHDkRiTgFMNTg2smwt9QJviu1j1U/UDbC8f30Yg6oLRbN9nRGT0QijsFc5T0y43MxBLXF9nvbmV5zZ5m2HZxqGGX2/uSUFnw4jTHI7Hm7/QSn41RDmmmvOqPHXMswrWB3bN59hrn723qY9WdOl32j0ZOdgBZaaOHUQYugNn8025yca0I3QnM3n2cKQa2OlVzYN1qkjs4zjG0Nwrme5Vl4r6Tv8W00rlN13E44UWkR1ObGIM3dto3McW2E5m27RVBrYT4YpXn/leHUX2T8rKOZEetEkzhGWbg630LDPxUNUMuN+ZBd5urrh2lsJDwdCWpnCjK0XHHPB618+hnExMQEiUiFh0Z2JQb66Uq1g+XEqZY9ClWfV0Y9HvwBJBN8LeLwPikqodKQNACBbUTJZia5+/uP/YUl+eiGNdDXB31r4KxNcZRfJmKbJCKKiGWivABTgmVItAyJaSFHLHSlprRGK10jiph0d/Qz9loBW8Hmtevxqh7j+w/yyu5nCTRcd4Oga0uKQ4ckB/aO0dNdGwqFDxjYRpQ9e54h3g52skCgy6CNGmHk6M19rTWWJdFaI6UkbVlUIh433rCa9seneOKx0mDUhFLGJ58NiDgmWvohCU2VQJsoMU3KkBzDSRNH5JpmhTQkuVyA40DEMZBS4FU8qp6H5/l4ClyzihSCto4OpjIvsW5Nge2f3IAKNC+/tJcXni3w9JPw5E6491n453+CfHWURHyUnlWhG8/eLhgY6Ke7p4+NZ22ms6uDLW+8llWr0hRKGcBHE2Apl4hfIihnKJZyVN0iU1OHyWQPc+DQIcaysHcKxrJw6ABkpiA7BQcOwOOPwE8e8vn72x7kN3+1n3e/ZQ3t8Sl0KYfARarw5Hxx3wTxtA9CUZrM45jUVO3CfNKmxjc9kAG5kkfCTINcxf/57C7SMf4ve+8dHsd13/1+zpm2fdEJdpDqsmRSlixZHbJlWW6xXOIbO/E14zjlJk6k1Jv6hk55r1P8RE57Xtt5bTh5k7jJolwkW5YlqMuqJFUoiSIJEiR6W2yfcs79Y3YJsGEXAAsg7ed58CyAmT1z5sw5c2Z+853vj2//V5Hzz+vnl39zI4XCfkxTYJkOImLgeprm9lYwDCiVKUyNk4pNY2oLU69EGXH6cxNMl4tkcyUKBRWZmOK8conzigUolSCbBTVLF2Zoja3B1qH4sCURHlFbgmmBacDKVVHisRjpdARD5onFXJrSATFHYysPQyssaWAYAmGbCNNAy6AiqIqCcBFGgNYK5TFnn2ltTTNVLBEEZV58AaSACy6A998ch7HX0NI74dc1ELdX8FDvAFdeDhe/OUlm9FWk55NMtOKNTWFZTkVp6aJUgtaWC3jih/38y+c0v/Cz8Ef/80pa29byqx++hpvf+a9ceiWsOf8SpiZc7vzWE/zJHz9GXsJvfAaG+mHwNdj4FvjlXxUk3B14pQmkBOGAsFM8/8oU3/zhIH/64XdTHn2UhJOAyEaGR1v5p8/fzb/+k8v5F8A177oCd3QHmy6DA69CJGoyMThIoslGVmzLhNAoDE6c7tMMz2UnSMGrBEznJZ6fpJizGOyHQo6Er9l84ztNLr6ogxgDrFwZw7JNysUChiWBesVAEmGmyI4WyUzlectbLqZQzON6Jfbu2cPg8DgtK2HzNWlGRwdwki6jY/2saT8LgUIHPsLzyYxMokuwYeUqLD8Dho3Ex5YaaQaYGiyliJgeWpcIYjZ+0sRXHqtXmXRtsBid8Bgehe0v8HOZSfVz99173+3vee/7fhttV86lLggfJ+pRLBU/Go+JO558cvpDadPlsk3tKGsaMyaIJcCYpn18fDy+NnnOmbYP7WIR4rQq1TSfC3GDqbqxwbxEblWR2pZaK9Yqc4HbX8z3t3Nkmq0m4M7KZ733xt0cm2rvQZZ3HH1LHeucaP+qAqGeOcruI2y3PsI+f6J1q+tXs0McThd71Do9lZ/NnJ6YRq0X/+CNI1CbK8Z0pgRqtzLj+HMqqIrUthLufy9h/+s7Rds7HrX6YO/pqMQCqPUi/dFUXePnyy3MnJcfZOa8s9zYTCPOfrLpPs7/9tOIKUHonNrH8ef3PmZS5jYxI0Sfq39WxeXVcbz15FRzUXTXWP7g6ahEgwYNlg8NgVp9nEj9XSXDiSeMbcwtEFpP44LodFNLbNhNfTcbZ+pmsJ6bh6pqvsHcdNdY3jvHsm3UFqg1aNCgQZXGPL886a6x/Hgp3qtsY26B2vXM7wFNgwYNGpxiJC3NHeAPc9lbz04MH3rNjiViGFYUtwyFaZOH7h8nmWZnxOEjhgloD9BoHQEleODHvV3K47upBBefu1Fy+VvX09Huk8v145h5WposLENgmgJ0ELoLKQVCIzCQwkELo+J6pkEHKCpiAG2CmeKJxweYHIMD/S9TLntkMjnaVkgu2rQOJ16G8X2s7+pkePAgs92StPaJxyL07c9x3mbQcgrtU1mn8nMcgYqUEmFZRDFYnYqjBoq86awkq9NJHnpomEP7Yd/+Cc49uwlUDmSpIgLyjyhHMZOKsR5UoEgkwioppfA8DylNIraDYRhEKy5zQaAo5XM4hsf0aB/xOGQLcO46i7M6W/ng+7uATtxClD1DJfpHp3l51y727BllYACGhmH7jgEmJwdAPBPqwYKZVISpBLQ0QzIBZ62FlW2wdi20t5usXbuWNWs72XTJRcTSbWS1jXBSOFYay0rhly2yGYVjJ/n8332Rv/3H5/ij/zFAdmqAX9+yAaltDOFjIBBKY0rQuQwAjlE5HIKwDwgwpKTkBWBKCi707znEzp2H+OlT8H//fJyhQ3laWiA/PUYkGpAtgW0GGJaDtNPc+YPnOHQQ1q2Em647j871PhSzMJ2h6E2zuk3Rbhqg02hM0Da5QpnMVJZ8zscLJGgLVekjlmWSyxWJOREM6RF1NLahiTkRIpEIWmtiToxMJkP76hY8HJAuUuSxZZmYFWBBKC7CCCN0hgHCQAcKrYOKvLF4+Hgcmxh7pod5fhnXdWmxk3zglgk+//+VufC9sGJ9KxNDB0gkTvRNAMnLLw1w1RVx4k2CbOYA0YiBq6GYy2HF4vgqCOskIVARZLGT3/rM41y2GW7/h1/G6himXCjx8MP34zgwNga3/s7nuPseGB2F88+Gv/jN1XzsY5fiWGXy/SXihovWL1AYHcXS4FvhbgppcdUN8PU7Ndbau7nxphXIjGTns8/wuc8rin7YXLf/zdvwx/czOXiIG24+G94hcfOjmKaN0sWK41y18dRxHMwq6Oo5oPK3UIdbRgmF0hHGxsoQNDM6GnBgP6TS8LZrI5x7QTOOnaM9EcfzCwhp46Ri+MV8KIA90kPt+GiJLsOul0Z4/nngolfZ118mUBCPww3vXMuKjVGCYIj21Q6pZpicGqU9tQ6NRKIwDJODh/qIJyCVTuCpIqgICJfAd5HxJHhlpBkgvQDfzyNlGcs0QQpsVcaJQsfKJKumJOecm+CJpw/xzHPc9s1vfP/t7W2xD6BkH6EemaHhIp0rHLyy/HBBFnf+4N7SxW0dPhs2tpHzA6yohRSeXcgWE4bQZ1qgto1j47onEuQcl9npPhearqz6vVOR7qyeMhe7/QV8f4qZuFpV9NFNfS9zVt1BZrOD5R1r20JtAcnXOHGf3E7te8itddZlc2XdWuOghzAOfTunJ85cSxx0THrF1zEnevk9w5kRBPVWPrs5tSKt7ZzZcV7rBcXe01GJBXA79buoVR0t5xuLqj6X+honSIe8jKj1knGD+dN9nP9tOc11WIpMEQr1umusU+9577ZKWZ8lHIdLJaZca/5uGHk0aNDgCBoCtfpYqHsahBPEXYQq6bnKX84XdMuNWpNld53lnO7Jv4njB9WOJsPyDticThYztrcRtvWJjkea02+Df7rornxuZ+lcBDdoMB+6K5+nsw8vpbHSfaYrsIxYzDzRR33poHvmV6UGDRo0OAVU9BtSmihtMjU56fs+KpMpkIy3Mp3P8HDvLhwTbcrku6RwQZcPC2aElvh+sM7QPOdEaLr2mjQXnt9KIjqNYxZY1Z7E1BqhNAQi/NFBaIxlGQhLgowxNuLhBwLDdMhms8Rj8Zk6CgW5YVpXg5WAKX+S1nY4Z3MbTU0OSk2H9Uk2kdRxtDrIyNAwq1eehQo0qVScp3c8gjDgkkvSlP3MLMHPsYKVanpRAOV7+EIj3ICVTQ5RVWJYZPnUz6/lP/6znwd680RjUUwpsUxoazdxPT80loNZ1mlHP9Q/gQtNRUBjGAItNYGqOrGFP4YhCYKZ72ofDEwSEigFNBugCh5Sj+NOlZEMgoyyvsNhfafJ1Zs6Mc2VCAN8rfADD2HA3r17mZryGBiEiTEYPAjZSRgdgYlp6H0KCi7kc1Aq+bSm9+F74LrgB+BraGqGFSugucXGtk1WrVxFsVji5V0HiQrwFfzgB3DbrzoEpXzYzkIg0ciKiRWAlAIhBFqrsNUEKK3xPclAv8dUFibz0NICn/w0SPL81h+2YVICUcB1wYmCVhoV5CipZu66Dx59DCaHYXXyFR7q7SIiJnBiELUsojEDhaJUylH2JIEHOqpY0ZbCdd1ZrkGiItDwIbCAAJQKD4QCqXMIkcM2TaK2S2drBOW4yLUX8viDz/E3n53k8svgM59pwzMmEb7GQGNIk5HBUbySpLW1g2jMAOGBrggGNZVfZvfTaupIQdkt0dG+kt2vDvCTH5f5/D+ehaVLFKdHScQEqKoY81gEcNZGA0QRXVY4AvxigFYG2o5jplMUiiOMTpaIJqFj3YX8/LvvZKoED935C1grHJ54SnLntp38/d/uxQRGeqGpCd5+E3z8Z6Ncf+l5aG+M/NAPyfoaI0ijhcSSPqZloH3QWqB9AyU8fuePruXbNzzMFz4Hf/tXwyTssK8h4OwN8M2eN3H5ZhMyI6yI2PiZQyhkmAI2CMWl4f4GgEbISvsJfVQ7zB6Hlf9rCyEMDMsiXyozMFDAiaxi774MD943RTIBP/uxFSRSJdIpn2TMRpINj4X28Yv+LCFc5XOWo+KxSHwlaV8R5bIrihh2maYodHTC2nWrwTIo50bxfEXMsiiWISUE8UiUou+TaGqhbJUYz3tsPC/NVCmLNExU2cQNcgjfJ5LLEo04RO0EOBLTcsEvQ1BCa7BFaIbpyTJmc5RieYjrr2ujc9UYTz/Nm7PZwrMoNhsGB+JJaO+AQJWRMkEylXrXWGH6UO8TgyLduRolTVyVJ1CeSqcivm2f0fBzFzOZHqrO5L1nsD5vVKpx73qzDWzlyPuoWqkqlwNb61inZ45l2wgdrHpYfNx3inBs1MPthI5JvZz6e9da+3Wqt79UmOvZRe/pqsRR9BHGN27j9LuanS5q9b/9LN1neFURaa2sPlUXyoXsx3zOG0udzTSuBU4mTRz7/PuzNNq4SnX+vo3FZ9LYdhLKONkc7/gfTe9pqEeDBg2WEQ2BWn3UujjtrWN5LYHa1vqr02CR9DH3xXrf6anGvNlGfVbNt7B092Ep0cTi34rqpfbYrlXGcqCLmbQSR/fBDGHf7OH1sa8NXp900ejDDRbGYgRq1eW3zrG8IVBr0KDB0kJLksk0r7w6PrV+NXkVELetBK+9uovxEbBjzq8Zwh4KrccqaiJtonxT+F7xAQ1NN71rFetWK/xgL81NCfA9/GIJ5Qssw0IKifLBR+JqEzdQlP2AkufhuWkmxwvkclnK5TK+Xziiep4PGza00bk2hevnQJTI+h6FTBEReCStJJGCRpUVjiPI53J4nodpRMhmpxkayXDp5aG4SCtCwQqqooo6VrijRJgmUVX0ZcL3iEjoTCtsZVAsT3Pt1XDXj+D794zx7uth00XN5DIFmtqTBF6OQPmoObL8iYreSIsjty/EjNuSYYTLdCW/pDpK5CIrfwstkRokQSjoEqBVDp8C2hdoJEEl5WBZK7SoCJxMMGw4f6ONaSYxzDSINARp8KJo36asTYqGYCJXDo9RVtO/f5zx8QLDQ5NMTpQYPOSSycHUFPS96oJw2fH0a6RSsG493LClidXtirNWTuPmp7CEG+6NVPh6RuOlA4kpYziOgzB9pM5QdkEpTcyKceH5HWAlAXC1IqCE1lmEnkArr+KMV21HUMIH4fPOm+O0duQZ6YOmCGF7CIkvfQyKoARBRaRjCYlhSGzHxPdzdHQ04+YnEUc540HojKe1BhX2LaFDoRW+jzRyoIsEgc+9d97DgUNw401wwdlNoTOXDECC0ALbMhgZhpd3Kv6vX9iACg4BZdAWOvBCA7ATmHApJMl0KwcODtHXp7nlQ01gTAAl8KtiKXl89zARloB0EYBREcOZEYPpgoNiFY8/fYDmzjjnX3I5BS/g3ocO8JOn4POf/yAP/fRFvvIbz3HPw1AshCPpZ26En/vQdbzlkmY2XKig+Aoq8zIyKGFT0ajKadB2ZQdspAzlWzoQKFGgKTnFv//vTr70xSF2vgCJFJx7Fnzwliu5/uqVpCK7IbMLynkIXLAIB6y2QcvQPU1U929mrB3PhU6LWe6J2gRM7KZOiuNZCtM+ttXC0IjHj+6bopiH9763jXjCI2q72IYKhbrCrWwkqDinhaNz1lYOH63j4bolVq5uZsObLoSgAM40qjxBLj9M4FmMj5aRVpJoGUwTRkd88qtzOIkEgTZ48rk97B+CssgwOFlEa4FhQjQClilY29mJX9QUSx6mdknGTYQUYCtEUMCotJWQLtKQrGg3yRamuGRTM7FYjgd/4jUXyzwg4GytTB2m+wSEIsAcNJPGrw1NBl98+LFD3HTz9QQqQ6CK+WjMyrjl/An3+zTQRyPmulSouvbUw+x7qM+y/I/hFmrHdDPMHZPorazzAeZO9VkPffNYt4dQoPZVZlKHngrqecD9RnFg6Z5j2ZkUSM0WSXafwXqcKhYb/znTVAXAx3vudRehqKV3EeX3LeK7Z4Kq6+TxaDionVyOHjtVd84GIT2E586thGO0bxFlLea7p4rlLO5t0KDBGaIhUKtNF7XfPKjn4eRcFrubKtvpq7dSDRbFduY+pr11ltO16JrUz23Udk6DxpsJ86HWhdMOao/JbdQWqN02jzotRbYyd/9LE6Y6/SThze4WlvcbrQ1ef2xlafThzSydm7HGGK2PzSw8xXuVHuYWqNUKwDdo0KDBaUQyNTlNarXDBz94tb/nlccGldAdr+zex+5XMqB50Xbkl4SlEMKoqLbCNIjK489819t4xdXQvmIULT06Wx0MfFASpQQqUMiojef5TJd8imUTYaeZygYMjefITGv27tlPNgeFItg2FI5OCqfgkafGcKJjROIQS0AsCm3tsKotTrOGpOkRj3lYpo0TtWnraGXPa4fY+eJTXLjZYM26FOWSj5AR0LPScWrzsEClangmhCb075JIrVCUEYGPIQ060jEODhZYt7aVn/mQ4Ov/Pca9P4T2pKRtRYLhcoZkWmCYAssyCFSYshFmdDCCinxFVyRmx4iPZOj4pE+gSqoUplCHRWnoigxEi8PfFyIUo6GCisMTyAAUAiklUhkIBb6n8HSOwMsS+AfRQiKlhSkdtBQYpsUK22L1WgfLtDEusUE2oXX6sKDOCzSlUhGlDCSh+ChQAY7jEHVsUC5MD4MogxeAKiNk6HHlm+DETJzIOeCsCNVYhUO4+QzKAFOBcEt4/gBaSFwh8BAgDITUCENgCIFRzaUahMItjY2QGT5482puuKpExDBoaYqTG+6riLFM/EDhlzXalAjLxDBsIkYcrQwMw2JqYhxHKUwdIARIIRDCqDjAycOH6wgsiQp8XKUolwoceBVuencHzcmVpBMa130BocJmkEKC59OSMnnsIZ8rLi2w7uwIGHlQCVDlimthcLiPVgVXSgDKxC9H8D2LSy6LERglkF6o+hPV1JXHprCtVltVUl9KrTBV2Bfz0wGpNWcxNnQ+v/O7L3DNu+Cc7SO82j/Bf31jiHEJv/S7dxLVYADnng2f+AW46YaNbFy9ElspilMvkX1phJgTYAQ+SIlpgSlNtDLxq4ZmhxONKqQWSF3AMqe44nyT7v+4GD9XwjRTYMfBKxBknyTID6MNjRYWXqUEQ2pQPrIiUjvcPpWxIY/rIidRwkdX+o3SHiibzMFxctMa14swkYH//uYoroZf/KVVNKU0TQkTW9pYooRUJTD0rDS+ijDkOntbJ1aqSkPjmAGemyU36VIqlfCDHIEC5VkIlSQ72UShYDI8OcWhvfDWs5poSsXwpOS5l/bygx8PUhCwZxhkRWxoytBJ0DKhKTlIWxOs6YjT0eyQKiiSMYtkTCIMiZS5wzWXuNjAxvVr2D8wyppVzWzcOM7u3cFGreN/qn3zL4XMo2Qo/tQCLth08Zd2bN9+63M7uXDVmkkCX6IUg+l0yi8Wz3SGzwZLhKpYoIva8bYHK+vfXse6J5PNhMKbpsp2q857i2VrHev01LHONsLYRVVo0rfQCs2DPkKxwScr2+/m1MQ2asVP64nTvl6Yqy16T1cljkMPYXzjesI+vfUM1uVk00XYx+ei59RXY1H0EZ7DqucxCMfqGzUDylz7XCvD0nKnm/A8MluI18Px+/BtlZ/ZIur5Ou3Nfs5W/W6DGbYzk2FjG6+//relxvKe01CHBg0aLDMaArXadNdYvoPaF3h9lfXmEkXdwtKz5lyKzJVSsV56OPENx37qfxuma5H1mA/17PNdvL5uDE813TWW99ZRxjbCNwhPxHqWlihlPjQR7l8tl7nZfIDwfNfN8tznBq8vmgjP9/MRAC2mD/fWUZ+lQmN81sfJeHt2O7WvXepNc9OgQYMGp5x4IsHU1CiSLPmC3m0a5qZHHt1Ddgqa2uWvlwhQqnxYRyWFxPc8xw/4g2gELjgnhXKnaW+DVNomP5jFMcGxkxB3CNAUPMm0B9mCyasvHmJoNGB/P4yOgjR4xjD4qWWys+CyVyuGtaZEaLhkC+yYUkGHWwjWlRXrB0a5qFTm4miMrlWteVZFyrREPVatNsiUI6xub+GZXS/Rf2CYtees5MLrN+IPv4RpxAh0EaVLQFUao9BKh45C1f8ezsypDgvZRNXmy4iyZk0bewamiEU9/p9fW829dxzii18e5/ob4IKLY+SLLrGkSTxuYVhB6FCkA7QRum7JajrLipDGF5W0p5qKwEyB0AhC97PQyU0CxuHfpQaET4BCoNDIUGynQ7csIcNUlIYRYAozFBdqiRZW6PJVEd9pPLQuoQONKQNkFKTUaF3G98sEPqGOT4OroaRA6dDJybJCFzZhhpqySEUQZCVSeNk8CoWtLMj5uPlQAKV9iWGAsi1c4gTCJtV1Hnuf76P3/l08v3MXxSK87Sq48aa1rGozyA/1ETMCDMuuWNuVMQKJFg6BjuDpFjwNQoRyJUOZSHykKOBYLoY6QFMMFGncYoBlWWjXD13UPA+tbdAOhpnCMCO89PJuHu5VvO+9FutXteNO5JC64mJWTfEZyrtA23jSqZRhY0oFIosyPAIVoPyAX/xYO6/tH+NP/2iEz31uDSvbJCpQ6ACU1BSKOdaefwmDo89x7wM7+NQ551a2ER5PpQIMCYEwD6eyDCV4CikkIjDYuHYjU/4hpFAEQuBLKJsBhgoFfsBxhJBhnxOYBNgIbaJVhHjX+eCv5Lbf/ha798Gu/w04L+GJsA90rITOFvjwu9Zz+ab1XPqWFprXKoLRpylmHseWMSzto/0SpRKYpsBxLHBMkAKhTZTSCG1UNJhhWwotUAEUykUMQ1EaGyESk+AZBHmNgcQwK86C0iTwTAzbRJANM3geTodbHV/VMSWROgyDKq0Pj3dDghQmvvIqw85BqwQFN0belTy3fQ/3PwTJZvjwBzowzVGU8khG14AWSB0K/8QRRoyzhGkVZ8PAVwgZ9nstK06OIjyCgRJYMZNACLLZgFwR3LLF9JTH2IjH9MQIA8OgAhgfB1Vk6PLzOzozZZPtu17hRw8P/M+S4DutK9sKnsq4rusZ6Gik5PkrpovexsDnzXsKXJFMcGlbOk8qkefcDYIV7RE6OxwSMU0iIjENhWMauEqSilr4hQk62yIcGi5y2Vs3sn//bkp59w98GfkbQ0dclBvug1B4ykOa/Lpl0Pvczn1oMwKK1+JRh5Hx4hHHpMEblj7CGFM3tR9Wdp/E7TYR3nN1Vf6eqmx/6qh1jhcDq6bNW8z92hbqy4hRz3OBHsKYdpoZsdjpEJ7cRtiGacLYRzcnN67QRG1BwxvlucnRQpGjOZPxnNkii2ra194zWJ+TydYay3ewfGJpVVFagxOzlGK0J5stHP95VVUgvvWodY9nrHI94XxTr5Cqq/L5BRritBNRdaDcRDifvV7aqZvazw97Tn01GjRosNx4wwvUksnknMullHM+nFRK1XuDCrRYWgAAIABJREFU2sPcLmpLUqAWjUbn+5VuwgubzRwpyNtBeMPSw6wL5AWUP5c1b3edZfQSXiwd7WiSITwO9d7Yd82x7ME6yzhZ7Ke2Ur3BkdQUHhSLxTlXiEajU4TCwFouasvxpnC+4rQq1WDV5mg02ncyK7TUWMD563h0c+SbbSdiM+ENZDXI0Fer4JNUvyVLHfvXw8LcqdJAbzQa3czJfTu36ySWVQ8LGb/1Ug3w30LYd6viq6qj2DaODfgvKeocH7Xmid46N1d9y32u7TQEaqeXbsLrpm6OfUv0TDg1nFbmMT90M/d1/XHb6fU+/7ze2bt7L4YcxjTHicTZPjDgf8QE7Ca2l7R6SEkfoXVF2ATCMPCCwtX5fBC/5qp2oqLEyhZBItAwkiVuUDEScvG1wYuHptBWnGzGZueOMfbuAc9jxPf5Yls7Xzek8RLII9Jbaq0rYhIRmompUKgTBGCbYJsI4OLxMa7sn/RvjMhst/PidFu8CYIXM3R0Ci697GK61qcYfmkPcUeQaLMxbBOZL+D5Pn4AQiikaSCoCsNm6XikBh0ghUYLHWqTdBEtPTass2nvtBgZH+OWj7Xx9E/HeORZ2NVX4Iq3pVjb1cxEYRzbKXF2Vwu57AQyCF2NdLlqaGUghCIwdJhiUoUuUiJQMxkKhUmh7COtKLFEkunpArYVwy/7lIqCIADTNLAMEwKBUgFKVQUhGkyBYQikBCklWvv4Xihqi9omjg2O5SAtE61DIaLvho5PlgBTVMzcdNg8uuoU5Yf7oNzQqUpVjNuEgKA8jSkNLCHw8i4qANs2EDh4fkBB+yTTa7H1Bl55Mc//+pNHufdBsBKwfiMcOAj/fT8k/7Gff/vnLm6+fD3Zwf2YXkA00YwMAuxkFPwIrLiYybEkRT/FZCbL1MQI56xtpz1ZIjfxNIE3QlxALL2Gb3xjmNExjxuvTXLuWa14xQK+L0hHOsFq4cnnXuM7P9jP6Bicew4YgQc6g1YB0gy1Tq4LkRaT8qSPEzEYGCvSuv5cil6K3c8P8fyzu/nox1qRZBGEDlaWI3HsNE+8MMnzfVE62ldAcAgfEAShk5ghedNV8M0fw6/8RZxMXwblgxMxEQI8BYnmNkg0U8zlUXhkM0OsSMXRUwUouiSMKL6IIGI2ZkKSd4fxfZdyBoxZIjVDEgq9JEgJFgmEswqCFXi5Nu694yB/9blvsesA3HAjXHRJuP7Xvga/8ZuCn/35i4jHPYQfxVQOpXyKsX0ZbCxitgO+j+mA4aQQpoUW4AceRTePpwI8X1IuCiCObSUIglDEdeSYl2giaOWitY9lCOJxC9MC13Px/TzVTJ4rVyQxTAPtuhTzYXpgywhdxECgA+Ows6DQGq18hBYIUyKkhVm2GZ8uMpkrI0zJy3vL3PPjAQ6Nw/XXQvelMVa3F3Ecg0QsRuBnEJXUoBI9o0k7yvEwNHXToYGaEAgnTK2pjDDNbLHsM5Uvk5ssM13SCJ1iclSxb4/H2AhMjIC0GRvN8IBtcF9CcH/EEVc/+tzg39/3yO5vT+T1FzIlXm5dGcUv59FCYUkD8DENcByBEAKRNPC84E1jGfVz+TK/+sKruv3yq4pcnGoipRQrSiYr1nZAoYBtBJRVEaF9TKVY1Ryjzx3nootjPPnTQkIQXJ1OtT+gpQ8olFDseeVFbMmDhmb7xHh2sy+yJGI898ore/FUaiFT0rzI5xsubUuZeDwOM9eNt3DUw8pC4ciU3vMlFoudaFE34b3W0S8MbeVIkdXtHP8eOg30RKPRxYgZttaxzoPUd//RW1n3emYecm+p9aWT0L5TlW39OccRqZ2E6//bqO1e3rPYjZwp5tE+1djfibiLMx9n2cqM+GUb0FWJj5+QWv2vVvx9sdTR/l3Udk87Y8/tFjt+l/v2F8Fcz2O6TlclzgBz9dXbOPIcs/X4qwHhHFOv8cJ2wrnomHVP9fheRtzOzPPoWwnbqqfWl870+Kvj/Fnr3Pg1Xsfx1QYNGiycN7xArQ66ayyv94Fib43l1xM+8D3TNxkLZTMnvpmH8IJmE+Hke6pSqHXNY93bCCfGLZXv9TIj/qiXpWLFOl9hXYP60rb11llWL7UFalvrLGupsJXFiVuqb3IulTGy1NjCscKeWqQJA4FVdjBjzd0Y+8eylcWlTlxoH66+SXo8Tud46KqxfDF9phrMOF7fTROeO2ane1hy4vs6aWLxKd5nr1dLoLZcWIgAv9Z8spAy+xbwHah9vVrtv7cSBlFu4415jp3Pdf1Sa6cpln8/PfMIBcIHzU8U/JXSEEj+GhGKuEJxllFZ10fr4HwEoVMVoQDGqKQIrCq8PFeRQ1MILEbHAx748SSDh6A5yd/FY8ZfNDfHckJIisW5ArCK0OZJH07XVzHk0cBOjbkzlm7+oiGtuKty79Be+aO5YvnDhWEdyT65k4MH41yytgPPgFx+EifmEk8KDMvEitp4noc+rLo63Bjhx6z/a6EIhAR8hPYRlIk7sH51jH39k1z2thTtnUUee8zj378+zZXXTHP1tefhlscYGC3QnDBxTJ9CASLyOGZWgnAfDQOEQeBCsSQouhLhtDA2nidfHCeb98hlpiuinlAw5ZUgUGDLMKujJUEaIK2wOMcBOwK2ZWNZEeLRKFHHoOQoLCPAxEWKANsEw7SxHYllCaTQYSsHCu37oKikPgWQoWANCAw/lPepsI2caDN7Xhtn/dq1lN0iVsRnIp/FsiOk29cSlBWPbz9Az/95jTu+DWs74fd/5xxu+uBlOCkLO9rKd+9+mN/6raf5vT/s48YHr6MkxjBFClSCaNt6dL7IY088z30PDfHAk/DaIRidDve3yYZ3XANb/7CTla1RTIq44zn++I88bBtsneX8K1ZReG2MuJNm8MAw9z+wh+degbMuhN+97c20dzWRfe1xVM7FslMI00ZETSK2CdNT+DqHI0w617TxZ3+9gx3Pw8bV4EhQgUIYofjL0ICbpa11LYGY5CcP7ubGK87B1+BrkAiSLa0Ux4f48MffzI8f3cnOJ57j7HUGgQFa+0TjoEgwPtnEl27fxUQern+74LorNzKdHycuwcAFAX4QoffHh/BMeOcH34ppaCIpCxnMcvYSgqBcJl8oUCr6ZCbL9PcNcs89L/HDu2EiA21t8NUvX8LN77sMaQ3w+GP30dVW5hc+fSPDg71EYxGcRAt7dw/z6U/9mIlh+O6324k02XhegFv2KQYePopyIPA8Tdk1cF2N60nQEUoFRXZ6lFLBOzzUlIDJiZmqSiN06zNMsOwStg2pNFg2xBxJxDaJxFN4pWkipqC5tYOgOIXwfZQXOsyFY6vqrqYRQocOg1qBcpiYKJItxsjlDZ54ZpDnXoBkB/zyRy9kbaegw9pH0skSi0ZBeCjhhXXTlXIPC9NkJb3oTC5fITg8YpRSaCUxos1MTuQplxPEkq3sO9DP8FSBA/um6d8PXpmybfBtK25/04qmfiL9TF4IE3yB9vTI0Fj5O9ows8QgnYSAAKE1h00g8Q+fOSUWphPHtKwXDUv/mesV/ibenPvzh5/g93YPDPKu65vpXNXJ8J4ROla0IKwAgnIo3AUUJQwAGfYvrYPzgQfQElWxghQzGr2/Br5V+f3+w21yTGrVBm9AqjHXD3D6YuA9nPjedSszzmpz3a+lCeM3vQvY/lbqc0/bOs8yH6j8/klmXrA51Wxlxg2uKlK7jcULxzZzZLzreCzXuMJ8aOL4YsrZLIV26CE87ps4Uqy4VO4HF0JPjeX761inwdJjrj5Zz3l5ObKFuc8haWZEZ1uo3Q71irO31LneG5k+4LPMzHe3s/zdDrdSO3a+9dRXo0GDBsuRhkBtbrqpLWKpdwKZbYF8Io55g2yZsIVwQq1XaLHYFGoneoC0njCo0FdnWbez8Bu7Wg+uexdY7kK4jeV9IXMmOFmuOBAGD+ZyR9zE/PrlmaaL2oGhetjEjEClwUy6glpvhdbLJsJ+9w+E4oCtLJ8+dqrp4sz14T5OPM93L6o286PWthY6Z/RQ+63SKmnC/tnNqRGln2pqzRP1pHivso2503ymWT4uat0L+M7Rao+TUeZC2MLcabmP5pOEdVuuTqgLZQvzb6eq6HoptNN2lnc/PeOoipCiwhNAoAUG8J2j1pz9hxE6Z0kUJoGw0cJFCA2mhXYhUxRMeyb5yTQ//N4YQuNfeG7yZwJf3iOERGsXP/AxTWuW69esbVVUK1rr44jIQjQ+7StsAl/ly2W+q+G7SYPf15qPDh7k0xMH8heNv9LPxjUp1mxwsIo5kgriSUhYNlYsQrGYR6Iq4pIwlebhFI4QClDETP20AE0o3pIU6OpQFEsFmmMOa1ZF2bFrmnvvh12vvcKHPnwBlhjCFkDMRFOqtLc4rElzfPAN0FqgtMV0VlP2EpTcFK4X4/nt/QwM5zk0FDZJqTAj3JFG6HKGqDg26YrxW6W5PA88N/zdsl1sy6Wto4xl+UQiAY4NG9YkiTsm8ahJJKKwHA/bCbAccAxNTKuwf9gmhgfV1JOhZZpCCh/f8MPsoiJCTrfx+S+Oc/65/Xzm1k8jnH047gR9e8Z5+ae7+cY3Cjz1LJx1MXz1W/Deq69DxhyG+59AFzSer/ilj1/GQ99/mnvvga1/+RB//mdb0HKS7HSRf/y7e/lf/wrlMuQVbD4X3nkVrDgLhAV3/Bf88CdgRYf4ypfeArk+vGyOL/+LwT0/DPjI+wwY2k1zOoEuBcRtg8suho9+vBMrbuGV+/H6D5KMtIcHJt4K6Rb6n3+Z733vINM5uPk9cP6FNqYBF5wNHU1w4zss1q9pQugJDB1mI0UAQZFUOsZlm+HxR0EYkkCEokIlbXQ5IJqMcF5bE5svgTvugM9+9jxU8RCZbIaYKQnUKm797Zd59gUYy8BX/kPztX8f5car1+BOHsCghGsoyjrGM9vhX/4Nrv3mU5x9QSsGBkLPpIA9sH+I8TGXwQEYm4RMAXIuJCRsWAuf/RN4/7vXs6LZZGDfXSALXLjBZtO5USb3PUFTZB077t8DdpavfwumxuBTvwgCi4kJl5iZIlcoM1kqkfUUe/cXcD1wSxLfNShM+4yP5picAN+FphZmxFyVTyFCPazWoXuc7x02IiNfgFQCWpoVTQmXdPwQ553Vwqr2KJOTk6xocYhIA0MGoH208FFCHXaPE8JAK4UfSDzXZ6yoyBZifP2/x8lMwWVXwRVXdmLZ4ySFT9RWRGJR0OCWy0h5ZBrPmZTAs4VYCiXAsEKnNl8pSrj4rklmIoPS7YyM2uzrH6dvIMvefpjM8EJTmi+n09wRiXDIcQwCAixTI8LcvmgppvN5F8cRmJEIZtTC88tooWfO0JXziyEMhBBoHSCkxIlYmFY850RSv28Yww9MjQZ33f29STN5E6RjkmiTImpWrBDDkytS26AildOfDygTI0ALhThaOFyZL6QmIJxHwpS0DRocGbPYwqkX22xh7jj8B2atdyqoxoFq8SDzi0P2cmRmkH9gJm3pqWYLM+K4NOF9QxOLi6/31Fhn/yLKXy40ER7XufrrfPvJqWQL8Fzl903MpJtdjmyl9stK9YzjBkuPvhrLl7NZyInYUsc6VdFZ16mrRoMTcDth/Oxoge9SiKXNl3rE5Q33tAYNGpyQhkBtbmo9nJzvg8RtHJtW8ujt9cyzzDPNFub3EKvKQifgWuvewum5aa3VN/pOQx0gDEj0nKZtvZ44mWO7j1CoMJdg8XT1y5PB1pNY1m2E+/16u9mbL9Xjf6rezqqKA26nIQiEM9uHe5nbcaiL0zM/1DrHLeTGt4f6xWmz+QCVtL8L+O6Z5GRfA/Yyt6tf9wLKbFA/W1jY9ep6lnfAaL5s4fRe1zdY4ugwpeN2oKQ1SojQaEgIUFojK0o2IRkO3YEkASYBPr5QWEKBcHCVoFg2yeaj3H/fQQIXAo8rpUg8rVBhobiha5sw5qyTUqH6IThaw1ZBGi5K+0gzQCmNKazBWDz6Bc/zvpAbK354z37/1vHJiWtfOQRru2DVOkgWIZUukEzYWMKk6jcEYFSd4ioCLNAVIcqxFZBBgKE0dhKSCYE0Aq6+cgOYB3j8qYC7797FJz92NqNjQ3hN0NnRjpefCgVxs9zmpIJAR9A6RSYLBw7meHH3GP0HYWoS0ilYsQKamqGlNYFjQyRiYztmKLqpiOlEpa1UVaGmTSDO/oMTvLwrw/6DcHC0PGla3ONEuTRict6efVlSMWhJQSIeuq2lmyTp5ihxS9ERM0jaJlY0ehwzJIVEYCuBYZRBamLJBPEk/J//gudf/jc2XgBFF0QAtgGbN8FvfOZC3nxFnFR0kvLok+ixMmZZY0YtpBRM9T/GX//pNRjlR+j5KiRS32Xl+jhf/lI/URNu/b3LuO76K1nRFmFlq4EXZPAjAjOyjqnBf+M///M1nASU3AKTAxOkYyZvf88lvP09kO9/lsykIpouUS4WicTjnLd5JdobAyOCpQv4ZQ2iBdeLsP9AP3fds53dr8HKlfCRj9qcd+EaCqVB/HKWD/7MKuLt68GAYGSYUlERyBJa5kGAJzQWHu96x0r+/guD+MIkEAIhTcDECzS56QGa10V573vhzq9DbsqklM+Gx9RO8MIzB3jiCfjgz13Kje9/Gx//xL/wm5+Z5tnH0yRMB+HnUAFAiU9+4u089Oj9PP4QPPrQOKXC0UcMHBNiEYhG4fJuOPucCDdcezFvu6KVVPJVgsIh3NwYcdvFsCWlUhl8aF65nqd/soc774D3fdjifTcr/vx/XEMQwND+PvJTkqnxMSazLkNZmCrDyDi4Hnh59Yry1DPpGO8eH6Z5dSdc9c7VNDcLBG4opqqIq7QUSKnBCAVeru9RLnn4SlIqKsYnsgwO+hw4CJlx2PvKBBvWwYbVkBs3aGuRtDeZmJZGiQBRiYIKAxASEZgErqDo2ggrzRNP9zOVgRuug7de0YIhh1jZ2kY8ZqK0hRABbrkcpiFV6liR2nFRKMNESxM/gKJrUXQdMkWHV1+d4IUXswwOAxYPp1LmF1avit8hJTNub1WHtmppInRyjCYsQOFrD7/sIozQpq3qbjgjNlaAgdY6TEmKj2lp8vksyWT8bmFNXzU+xJM/fmiSm9/ewsi0R1orkjEJyggFaDoCKgZKAQUQ/hDCBaHQQiKO1A0r4FEgcoIGafDGZTszL+5U77VPJVtOcfm1qPcFxa0LKHsr4bV3NRZZvYbvWUBZ86GXI8VxEArkNrOw9u6htvvKUnJrPhVsJmzXWn1lKYmktgO/zcwL29cTxjO2sLyO1RZqCywepBGrWa701VheHXuvJ7ZTW3DZW/msZ6wup/G8HJgiPO/0Ep7zl2ssrYvaYyfD0pq3GjRosMRoCNTm5mS6LEFtgdpi0pGdCbpYXDBhdgq1ei92ak3UWxZZp3o52X1jIeygMckvhC5qBz9651nmthplLheBWhdzC1D2E/a5XsIx2024Xyfa96orUM9Jqt9ypIeFiXrmSzUFaDdv7JS/XZz8PryF+sdvPXPU1jrLWihNzH09sZ/594+tLK4fbyJsw+U0Z3XXWN47z/K2UTsd9HJqn+XEZhYmuqqSJjyXd/P6Prdu5vRf1zdYghztTaY0f6shU5VsCULRiKyIR5RSGIZ8yjQUBw6N8ta3nI0vfKy2FEFmFKFNRidLCHs1P33qZbJZsE0+nmpuezrwLNABCBchQSpRcUaasXALBRUSywyFYq5XRFcy8h2DANfNA6GjmO8bmFLilxQCg1RT4o5Lrn3THY8/+tP3qyJ/uOtBrlq3Hi69wqIZj7zvsqapiYhhg1AordE6QCmPIxzjjiNOC+sqENqCgkaaJdrSMXYf7OPt152P7fTzo3tyPPzwa9x805uZnDqAlB7xqIUbFDAUmKbAsqNMZoqMTxXx3Cjbnyvw6FMlzARcegmsbYG2pEVTSxLLAtPWWIbGNEGIAM8LQnspgEAcbkMlQoc5bXusWd3KmrVxdr44xGPPKKezM9L/lkvf9vP3/6T3rLQduapvqPSWvX1cLuDNQpBo71C0t1ukogFnr7RIRnxa201My0OLIrajsByFpRS2ZwIehu9hmR7ZkZ388a2tnLVqnKlpaI3ChZfB5k1pLEPgFQOgHzEBvnKxKCM12IZF4NmoaYOSm6etZZyv/PuH+Kd/uJt/+ucJJqcm8BTc8r4Y557zZjxXMjpWZu/uEfbtP8RIxuWRR77Cjx4o0RqBP/69C8lkXqKpA7JZn8zQDlJOC1GnBd8sMe2WaFvfARmP8tgQjm2gR7MIU2AaJooiyhQ88dQ4aPjdP4hw7qXnQXGUsfG9KB9s2yDulNi741n+/ctlfuVXrmXV+rfwu3/wbT76Cdi0OYZlCKYyI1x3zSb++V8HeeLJF9n8phZM00P7Ctf3icYsioWD3HDdOXzli7t5+tn9dHevo5zpA5mg/8AAWRd+8Ve66TyvzD/8awdbf2+Egy8LLj4rAe44tg+mkyPdPsYvfRJ+dB/88i9uIiansCiE/VkoWtuacCIW0YhJoH2SzWlQZfzyCH5pL5nJcRzTwDBMDNMgEnFwHAfPU/S/1M+rr8KnPtVBNJmi6MFPH3+eA30TqKLFxKjH/gOgLXJFyU4jxpNmlGfcgMevvm7znt27XvjcxIDvXHQRXHtVB6s6IG4XiVoBtm0D4CmfIAjQIkxfqbUm0KGzV6AFsXgLuXyK6ekcubzLxHiWXS/Cs0/DKzvhkosD3rwpTWC6mFaRjpVplC6A9EIBbqAw7RgDB6ZwIqu4+/uvsf15eM+7YfNFLazuBAsbQ00T5BXK0DNZPKkIxdBhis/jnLuq//N8j3zeo6BhugBB0MH+Ay579o6yv98jV+BRO8bnVq9u+76WMw6OoZlkKHoT2jws3qtuRspKHXRomaiEQsxKZRpWQeMDQguksAkCH2QOhI8ZVfgCnBhPrVnPJ4ZH+I+Dk5L2tW0cGn2F889uBdfDjMUZPlCgVEgxPJillANhlZ+uCtTC0PIx4ry/BFLHPVk2eKOzjfDecj3h/XHPmaxMhXquXef74LiL+u7vvsbCYshTzDg9V4VNX61sd+sCypsPWzlSHAfhMd1cqVNfneX0UPtZyOtdHLSF+rLSfJalJ164nfCYV2NF1ZcTu1ke94P1xAkynHmha4PFUSuj1euN25k7zedds37fxtxZgR5k6Z13Xg9sJ7w+qJ5/qiK1W1gegskmaqejhvBaYTnMBQ0aNDhDNARqJ6aL2hcvC3HPmCvFEyyfFE8Q3kguNlXdesLJqt6Hsn3MfWG5iZk86qeKLmo//O87hduHsB91n+JtvF7prrF8B/M/ftuY+42r61kettFzCS8f5FjhUy/heOvhxOKV21gaAcfTTRNh+9QSQ55srmd5BYRONqeiD2+hftFGb43lWzj1weItNZb3zrO8Lk5OytRbCc+V893+maCb2inee+dZ5jbmDn6u59Rfv7xR6TkJZWwinM+2noSylir1PBipxXyv6xssUXQlvV5FrfZNXUkTqWQoQdBaH/YYU0GAIeU+x1EvFfJcODw+hWNqmvJlJCblckBAhL69kwwOgyF5MJ5K/Ldt2mgdHH/7s1J46sNKtFD8oI76ijhh1jiJNMJ6zmTdU8Ra4lx145Xf88rm9yYfefiTA+Ns3bPN69p8GVzz1jZGh328iMZ2DBAutgNCaDRVIcZcDm8ShBmmutM+UrhsXNPK0NghLj6nmdFDOR55CJqb9nDJpaso+9PEDUk0amJoRcnzGRgtksnB2Cg88vAE+/bANdebtK/1Wb9G0BaBmOFhWqHzmmlKLEOELk5Cgi1nXJwqArXQ9o7Q5Sgepbj/AM0Jk0svaSXRUojd90D+//3u93vPfvsN137Esc09XV75PxKxKDt37GjJ5fKX58rymtHdU9fnp7nixWasiAHnX1Cg5Pp0robWdovmNoeoVnRIG8syQSpMEWAJj1iz5jO/cS6sWQej+1ClCfzyJFKFLmrSBxEIhDIPHy1BuD/losIwDHx3nPt+8B38EvzzF85mzaqLufsHD3DXXVP8+qe/gtYQiYTuXIYNeQ8CDe9+R5p/+sJtrFy1HS8IcMwITlIwMJBjZDRPxJ8klopgtaxl+0sHaLMEtqvpiESBPGiBlgrPcFGm5BO/ehm4AaXSAGN7d+JENW4RVq1IMD6Rw2pLcNf3J/jWd2DLr6xER5r47k8gSMNl11zAwIFnsKSktdVk9Sp47HHovvE8Mv0vE/g5lLQwhEJqDyHSdG2Ap5/OcO3lccpFcPIu17xtI1FrL3/515/n/R+D5qYmulZDbjyADQYEYWpXwzAwZJnmZujaAFdevRoyBQxKoYWdVqCGCFQJrTW+gsJQ2I0sB0wDoqaJH9iYMoppGOzvH8G2YpSKiqFBxYYNTQyPGOy4/zVGp2B0Evwyni55P21rMR6MRINHWlatebK164KJSDpJsTxCzAl46tHHv1WY5iNvuwSuvWIDUTlNa8wjFiny/7P35mGWHOWZ7y8il7NWnVp6V+/aJVC3FiSxSCp2sRgJMGCMbQr7jn1tzwzyMtjG8wzF3HvNxczY4vH1YI+xKRnG4LFltRaEQCzVaGOT1A1CarVa3dX7UnvVWXOJuH9k5qlT1Wertatb532e85yqk5kRkZFfRGR88cb7GbKEFAKtNXFbgoyIWlG/JNFaIE0b5ARpQ9Nm5ymkBZvXruGKLTanrivy4v5hvvME7D82ygc+vB3LSJIoaOyYA9oFDZaZ4PkXRkjF1vGDpw5w6CW48Tq45tWriNujGNgYOOVWryrav4jij9ZARExLdK/CLBY5OZzFj6fIOXGeeOIMR4/B6DiDay/q6Lv9bdffk82Nc+TwgYDsFt5n2HEFfQsyCNeJRgoZKrepoK4MjS6XRxHJmZV/CvvzIMSnRkkHKUNhtvA8JfiKmeI3H/728C3tXYINazLkSz4JYeJlPbRr4RYMJid8Egl+vn5AmXZ/AAAgAElEQVTT2kOeyAWSj7qi35nGN+t0li28shER1CB4b+yHmQTPaqgV3rsB+qmvJBMt1O8Ky1LrXfjTzM2/0uzi7ULVRQYJ5q4DFXl9imk1s6XyCc1WgImwg2A+20vjtY1+Gm+Cm6DxBvHzFR00R9CDwJfVt5SFWQDuIrC3yPe5g8AuVzrRopfm/Hx9tMLTne8YpPY6YscylmO5MMhM8lMlZo85g8DHqO4L2suF2/+uBPQz09+eIQif/XusbJGLZte7drOy76OFFlpYAajpzm2h4QC8l/lN9BpN0M6Xgb+HxnKxhwkGo0b4OHOLed6oDpd6UayvwfGBJc4fXtkKSQvFUqjf7SGw94XkuxJQq4yRU6iWzfVS+/6Xm6C1EnCuyGkRdoT5X4gT7UZYKhtuti7HCd4PaiHaJb5U6KDxGDhXEnxfE+fspXEfCOcPaWUpxolxGr8T9c4j3Rbqo5fGfXGz76t3ceH2qz2cu/f6Fs5z+EohDQPbNv5uMgeDh4fJl3wmprIgLfJFH2QbL708zOkz0NbBH9pxBy1yBOo7DtMhNQMChtaq4qPDUHo+SvlEZLmq0ARhLLWNQqKRaKFQ0kNJB98oUvCnKOkCdsbkze+6/R4rEb/MU3zu58/BV786zPPP5Thz0mNs2CE35VByXZR00KYfkj68GVkKrcJPcBdagpISTwaKQrZUbFyVwCwe5ZYburnsUvj6N3IcOTJOvmQwmXVRQuJLxXi+iJfspmCuZtc34NQwvPeXDG56Q4arLo2ztlvQuUqT7AA7pbASYMYE0jTBsEAaIAUYfvAx3eBjuCBdBC5q5AybV6e4eAN0poe46bp2em4Dz+X9z/18z24r3k4svQYz0cHV1103uv2qSx55/Vtu/s833LLjlrb1bJvU4iMnctzzvWe9I3sH4Ym98Pgel90/dnj6RcXPT5U4Mak5k4sxlDdRZjslt4RilMmXHmNi9GXyuTGcAjhTIIohQc01wTdBxUHF0UKiBHgIujZuJZ3qJmXB+++U3HjNMFdd8gJ/+MnL+fbXL+Zr/fD/fQ7+yx/C3/4F/K8vdfHFf9jA6o1gd0yQA55+XvGjPavp/19T/ErvHt535wHu/dfTrL/ySuiwef6o4EO/4fOtxz3WbLkGT6TxjTjKAMf0KVoevu2gJg9A/jBx5bIq3UWbmWFt0oaSoj3RBrIT34CshjPFKfzuUe74d/BPD8LRoS2Y1jpcz6F7FVx/PfzoR4DXiRQxTCOwL42LVC5SK668GibyYKQ60A7gOHS3wxf/B2zfBAmg3YDiCKzqSqCcPEUNbgxkohuRuZJ7H4AfPAc5ckw4I+RLIxRKUxRKRQquwvFtlEiAEUfELMyEhZkwMVNtjOc9RiZLHD6d5egZj1xpHQeOWPzw2QJ7noOBxyd55NFRnnmWI8WC3d/ZyUficba99fabb3n1tdf955vfeNMj2668ZNRIZSj4Gq0cXvjZU7tNyS++800m737rZZilE6xNmWRSSUxD4aNxlMJD42kfT7looYKQn1oiACk06BJCT2LIcdLxAl1tebpieeLiFBsvKvDa27r5hQ8aPH8c/u5/H2Qov52hCYt8ySRfgnwJhsZK2PE2jgzm+PYjsH0zvOcd23Emh+nuSGEIgRYWSlooOZucerY7VYmZn0QyRfb0MMePZCmW4Nlnctx77whHjsGRE/y5b3HZ1TfsuKdkeqRWpVFCBaGOcUGUgv5RFsOPgyFdhABpCIRhIA0BhgAp0ZIg7LIUAdFHimmyMSCkng4ZGvWXCrRnokrtKG81seS6P5AJ2HdwiKIS5IpFtDSYmsyjfJOjh4eYGIdk0vq79kwSIX2k9BFCI6UOlDVlxUdUflru5xbK2MX03HEL4RxRSln3M0/0U//9tS/8HiR4H5597gTBYnEfzWMu/qA+Fu7bjZRYKnFH+HvPAtNulG9vld8zwH0EC9PV5k5R/TSj0N7Lhen77iWwuWbIaSudJDJOYGeVfrCIaNF3DsrTDHoJyDuNCKT30yJYXAio14fsXLZSLC/6gfcy0097P0FbHaxy7k4CNc/d4Xkfo6WMvxzoI6j3SvwlK3dNZyeB/TR6v7mQyeUttNDCIqKloFYbPQ2Oz1flrHKnWDWcL513b51je8PjlSogfdRXYOml+YlLP/VDpX40PGegyfTmgkrp6lroX4J8K7Gblb0LaaWjp8HxhbTtenZ5JytfSazWxKyfxpOSuwicUNXQwyvLZu/m3BPzdhDYZM85LsdyY6lseCfN23A/9SXS+wiezVJM9O+ivvrrBHPr4zqoP+Z9nplO9a3UD3l8R3jO4BzKcC7Q6F1sIeNEPRJQzzzTbaE26j3Lau+rd1N7LJ9ryN/zCfXIo/N5r7+TC7OeXgEwQSVRfgc+GiiitMTXAcHA0i5CFDHxISJkafB9B6X131oWnzkzRnwsa4I3QTqWIF/0OHlmlJeP+CiDF82Y+ROtvJCEIWeqBOkgiKjW0yQwVYONFnEdyoIrkRRQmTQiAT9QWxJu+bpCqYDvQ2F0lES8g1tveZObKxQ/8dOf7b135PjI33z/cXdnaecUGzd3kG4zaJceaWkRj3tIAWgToSXgBWSPyvwx8GUkPBepmDkI5bJ9U4aDJ/O88S3bmfzGQe57YIhf/7XNFPIOdiyOQYmhIRDJFN/71hFy4/CB93ewZTvEY+OsX91BfrKIHYqMSQ0oOyDjabtcl4KAgBJ8u2EZVaCchEZaNvglklaRrRsMDp85ybVXdoBXYM+eqVsffeT+b7zjXe95x/jEEIm4ybo1XRQKOVJpm7e//W3HE7G1/5SdLPzTAw/+m7SS7a8fz0/cPnRQv7NYcnZ2t8P6DrjykhidnUmsuEGHa2LFJaWRYVZ1JIkJG9uQQQhHX4NTBNcrhyQEiZLgiUAA7qWDU5x8ai+nzsBHPrKZtlUpwEMXJxk//BImPjdfH4O2LhAxmJqEdBfEOrn66jX0vGUPb7j50xgyqLOiAykr4P58/RHF7//JxSQ7N7DR3MrJU1/g3l3w0Q9aTOWzdHbG8UtFVFgWH4+p4jgJow27/TJ+8L2n2bsXfut3NoGaopQvYG1MEesAnYKcLKBjLr//ydfw91/6MV/939/nT/7DVZw+9APwRthxBTz2KJw6NEZnm0SYkmLRQWgDocDQHtfu3Ijwj5EbOkkmY4BbQvkjvOUtl/CWX+iE2Fq++qWHcIuwdm2MglekBGC2Y8S2cuRlk0d3w42vB6XGMS2F6UdEKwnamG5/AhytyJV8Stkijpuj5KTJZgWT4x5T2SIvHxrhwAHI5qGrgz2WiD3sFO1vtndlHr/2+htUSZ0hnUzQluwim83i6jzgIfwiQnt879EfPbz1Im591RWwY+cqTh7bz9XbV5MQJn6+gGeBZ4REK4KwlAIDgQFaIstqYioIvSt8wMcwIGYKEC7rN6XxUAxPFbj0ym5+53dT/ONXDnHvvT/gV9+/mZhlY8YTAEzmYkxlLR7+7hAyAW9+c4b81CDr1xokLIHvB3WjQoLcdKhfOeNbRSQwAlKYQoI2OX4yizSTjEzk2T8Iu38I2RJ7ulYl/s/3feC1P/QkxGImU/lRdLzCPStU2KfpcttGKIRUCPygueggvKhAIESopCaD/5FR16RnqlIJr6yuVn7u2gZlo7F46+23//jLX/mH/SfPcNlE1iMV03SaNuOFEo5K8ty+4xgWhVjc+J+jY8MYSVAaJCFRl9qQwqH+9Kd66OQqKTV53vmW/kov30LTt5HCCccrIHiX/FLF37uklIP1UvD96qqrTaCHaSXkiJAShe2rfL+NCF29BHPWAebux5oLOW0x1UX6w+9KxZwtBCShT7N0RKFdBESGako9HyeYE/QyXY87CcraTP18mvMnwkyz6CF4Fo02BkXYy/kRHSEiqQ0w89l+iuk2Nbi8RaqKDoI21ww5MpoDt3D+Yw/NkUEvNOyi+T50kJa9nyv0ht+V/dJtTD+TlTIO9tJc1IUo6tdKH7daaKGFFYBXPEFNqZqT6EYvLrsA8vl83ZOSyWTV6+ogw/lB5qi14HeY6oNQX/hbrUX7O2l+whypVdVbhL+bpdkF0d/g+GGW/tn1RX/Mw/6WFUudf6P7r4Ie5hC2bY4hBBoR1O5g5Yf5rFU3zbwMDy5iOZrCubbvGriT5pwdy4HbCByxS0ISWKH1v1Q2PJedS/3UJ6htAfqSyeRiq4ntZPHV0+qRe6o5ugeZDlNZy+m8IogrdULIbKVxiPeBRuNPIpGo9vMuQtuokf+OMP/BRu1rHuPfnLDQ9BfaPyxi/rXe5w9T/T3xLoJxuhb5akXY7xKgXj31ML/3+iWrp3Ntn7lcbkHXr2hom3/62ndCVTOHQC0sWqxWwDi/+6s3YIigDjSAgJKnAQoefPLAUf6ie7XHrTvXM3j4JIl4jNGpHOMeFA0eHB33wnXsHOiKZ1lBmrDM8gJ2WS0tIqpZ8YBQ43v+dBnCcgBMZCfOvi+hCdll/PCJ54KfREB00UqghURr74eZDuPaQtH/fx/4nvdHF20c5h1vvwRRdCh546xdE8MyfaQWCOUEYe0qoAAhBVopRIXSi1YeGMGxVWsl2stz7Wvh2w/CP//zEe54TyeDh8Zob4OORJonB45w6El4/3slr744SdcqB2EkMH2ftlQbTmkK3wffA+WrQAFJCbQfKLYprZHSRxoeCIEwFKZU2BbEDAvsNtAeAg9beWxZZzM0lufW67uJ6ZN89zFuf/YHD/31RRu6f7cgDEzaQnKMw6gY5sX930EJSSopVDE38ZjW+jFT8KfpONe5Jd515ATvPDhYutmKlejshq3bU7R3GHStXovrCuLOGOmYImG72DGJbZmIGCjlokIujqcgX4SSA5lOKLiQL8A3vnWEI6dh/0vwplsN3nTrFUhjiHx+HLtwMrABCV5pFCVjdMs2fvadS3ns8Zc4fQrWb4QtF3dw2ZW30f/Fp/n8Xx3jt37z37j5ltdx7yNfgCK89now9CSdGYvxk6O0tQf8uVi7SdEDuz2N3X4VD/3LEe66C25+PfwfcgNO7gBaSMbGDuGnYdgHx85x4sRxOjtX0/MGuP/fhvmTf2/R1ZaB/CiXrU9hT+XIHhtn3U5BdtLBEEEYRu1BoXiGLauTrO2xUN4YpBKATzE7QfbkBInUdtradvCF/wbXXAvtmwQUu0jF15GT6zl0pptf/tV/JZuFX/uwTbs9SbZUQodKhUJqrJSNLpXIFybJOTCFxURBkJsS5KcsTp/KceqE5tTxoI15iqdMi291tPOAUjxT8Ato6aJ0iYEnv8uW7RuRjCP0SaRWaOUghSDnDJLNjvz1hgzv2L4Jbrm1m1LxFK++bi1xGUMXJG5JIU2JU5rCMi0AisUiSmu08gljVKKUj+uW8H1FW7uNYUosW2BaEts0g/JQoj1jUPLGMDrg9ltiPPxAiR89dYQ3vnErfqlAseRTKnVw34ODHBmD3/sP20haJ1mdNkimbIRU4Cu0jFTHFEKKsL3rsDxGuY/UImwqhoXWBoePjqPFakaHDB75Zp5Tp8FK8Fk7Zv3xVNbje9/eHSqm6eA6DR3tAjHdqwVEVMIQnEhMqREiaL9agKECpUFDBiQ6FYb41GEpo/dNJYJQxQGlLei7lAq7RRGEL5ba5LvfvJf2JA9MjvGHJ85kWb2+jSFHM6Lb2Lf/NIfOQDrNJ8dPFgvCLJaJeSqgRdKWplwXleUHMMnx8Y/ciJrlhi6fIyr71NlEwArMCiWqxNl/l1XjZrhz1IzyVIMKSc7Vr6fq9bXKryrDtM5Kv0buZ6el5dlnL/L910pfVZmqVPutavoVdRH9VqILQ3iVBLV+gvfJLQRz+F1CiB5mvXNGNiyEwDCMGf/PRqFQqFfAuxOJRD/T7/8Ddc7tr5dQHWylzmatWf7FiCBXRoPyN0R4f3A2WexTwJ3JZLKXmYS8xUI/wXyhmh8sIsndE+Zdz09SiXuYI6luhfqnImwlmBvNhSQzg5y21PP/RmjC/zFO9bCvtwF7kslkH+d2Hj0XcuRZERjOdf230EI9nGv7PNf5r3Q00X/2hn9WjqORGun94fh9rtYTO2g+HDUEPtUZ7xoXtP+shRZaWBBe8QS1GmiknDHBwiZ191O/U7+TlU1Q20ltEkAftQfMu6kdammuakN9VN+hVZleP4vL/m9GFWmpJ1st9bSFoVHbHlhA2gMEfUM9AlwPK2fnw1ww2MQ59frEHl45drvSiAt9NKcedqFjsIlz6tnwTppvu+MEDtV6RMWPh+kNNJlmI0QTxkY7mfrmmO7WGr8fpr6t9wLP1ji2FOTxxUSjcWIv8yfkDobX13uXuFAJUOcCPXWO9dY51hcer0ZUXOn2Ox/01DnWR/33+lqqjc2qArSw4iBBx4OPYJY6GCBMXJ1B6pkqJp6KFM/UX3pa/ccXXpzYevWmNGvaVyEsRdErUfTAsOXTaAP0zDCZM6DFjEXciJg2e+NIbZ5xjTQVwQ3p6JY04JfvTwC+MNl86RV/fGTw4BNHThb+8R+/dqDjrW/McPUVnQwePsG2TRkShgeGDqpmdv1Ml3q6nDIouxAQT4LMnubKy9pZ/SGbf/3aMN/6xhgf/vB2DGOKYyfG+N6jsPNVsGPHxUgxhOcLPFegfInyTDxt4Csf3zXwPcnQSBan5FAseHiOxlca2zaIJwLSTjJtkkhYtKVtUnacUrZAPCZoa0thxDwSUtCddjkyepIbd3QzMT7CgUH1Owemhp66eEvmK0YsVb4XXyiE8APVqsp7D+7/GWnYzxhW4v8yY+LyYmny9lND6l0Hj+be3N6BXL1mkjXtcPn6NKs7bDq64pi+hxZZrJiBFTcwTQ/LVBhKEzckdsyke3UHV7y6G6SNm0vwP/7hKZ59Gn74hM9N1zvE2swwluD085CAoUtY2sOyPd757u1gJcAt4jlDGHI/H/rwFbyw7xgPPgAPPvQkHWvhs/+1g9/+6E7ciRewlEtbCtwCGBJyo5rU6o3EM5v5/f/0fX7yDHzi/76KZ59+Hh1bhc4Pkm5vI2vFSKSCZ61UgpjRQW7U5yMfeD2f/pMnePmn+9i2UYB2mBrJsWkdrF+VwcmeRKtpZUCtBRKfmDFFR7eNU4KTpwo4wJarLieJCfkuPvkHX2R0GP7ok5czNTnITx4/yLFheGr/Pr56L6givOdt8KYbLkVMHcWSFr6y8FwfrQU6rykWIZczyDqao6Mup0fh6DEYPlMiN4k2JY/aJg8b0npES/9FXWHfARHGA1RA9BQSX0tEGErSd11M4eNNjP3K+JD/O696Nbzl1osZG3mZzZshnpC4BYdsSVAsKIrjIM0ulNZMTk6SiLfjOA75QoFS0aWQB9ME0wLTkJwe84nHbdLpBPGEhWUrhOFiWAIpBKs7Mxw7Ms7lW9o4fU2Jn/wQrrxKs3nbNianRnjkoUFe/Dn8cm+KTEbRbhokkxpTKHytAwJZRVs3ovYtQrsPlSA1oITEMBLE2ldx8KUTFJw2Tg55PProGYRkvKj4NaETD+pQAQ7hIbWa0WUE6ozqbGYUgFAYAhCBgppUhPppAbtNCIEUChBhuUWZUBc114A7O5uSpEKSmkfMSlDI84znQalo42qL05NFcm4nTz/vsWm7dejYEffuZBI8b0ZXN51JDUh8hJhJIJaR8uXsa2v2rbPOjQjMs4hZqqIvmHHprHzk7OtpcP2s/xuVfzahq9H2x7PKV/WksxNc6P3XSn/2dm7d4BlXLX/0mwJDgzvzlLuYVjDfIYQYoMrGiNmktDobjRphnKXzS+3kbGJOPdzF0mzy7A+/Z/vLdxDMz2croC8WesPvWj6Q8fDTyGcKgS+lt8E55wuiTYRz3cR6D9Mbp84nRCqEA8x8zhkCcmIvZysXLjU6CGy+3obySkTqP4NLU5wWzgEGqK/+3kILKwG94ffs8eIOgv7oLpY/MlMvzammRfgYKz96VAsttLCC0CKoVUejxcmFEkx20ZigttjKKouJekoyjeqm5m4y5hb2axeNB8iPEryE9jeZZj300ngyM7FIedXDUqd/oWM52najEL7nI0FtK43b5oW4aD9X9NJYeWk2ItW+Duov6B9m2tnT7MSA8Ny7WLqQDucLtrK8NtxPYyfkLoLnuRjOuX4aE6jvYe5Otp4avw9S31m6h9rO561zLMNyo6fB8YEFpl/vPQgu3BCS5wL13lcHGlxbSxV1Lv3vhYD+Jo63nL0XMvSsb2xc3YXW8fKas1Aa3w+WsaXIMfjy8PusLTzzzYeP84E7LiaT9HGcUdwStCeTx89ani7nNb3g7FeonOvaiudzQjW+x+zsFZDOpFm3YeODhnHm6tzUxH2PPzFxI8D112/jZ/v2c/E2g452hRBBmlG6kaBatQBkQgSkOwvN1q4Ojp4cI3WRxbvfCbvuha999SC/9Ms3se/lH5JYD1ffsob46hgjY5Cd0pQKklzOpFQwGBv3yGZLjI475HJw5jR4GnwfIq6LED6G4SMEtLc7tLfDqq44mTaPDWuStKU8ktkiqDypJKzZuJaN3SMMjY/x+ptXceT4MNrhy8eOTHzz0ktXDWnpoUSg2FSvGj3lkMr4KOW/aMd5UWs+n06x2SnxruMvc+cRh54DbVl7TTd0dkO6Hdo7oaMrRmdHjETMp91SWBJMw8eSElWYwnFLWFaMibEpPv7vd/KbvzqOU5zEdQ5jYSK1QmkDtF/ByAjl1KRBafgkjgcYoEwf2zuGNE/x2c9cwqf/NI2vDLQ1RWZNG9kTL5A2DaZOT9EWtzGSSSYnHTq6NmLELuO3P/4Qzw/C17//KR5+aBf7/hmGx/PERBE8n1TqUmJ6BD05xcvPurzj1jdQnJpg8/pOJoaf4Mih41y8cT34mngS7vhFSHU5lByBJcyyUpiexRzRBDSwgR/DsYdfZOwMHD8MU6Pwrw9dyWWvXsPTT+2m4MDBg3DsZfjVX4Sbr4f3vv1GEokzuKcmyTkJ8kVJPhfYlfJTjAwXOH68yJkRxYnToA0cDAZseCDVbX49Hk8OppJtSCkZPHq0RgOb2U4jWzEtg4mRM2ucov7y+lVww3UZhDrNtotsnJLD/oMnUR54OobvZTh2QlEsKIaGhpiYUIyN51EqUPty3eAjBFgWmIbCMKCtrUB3l6I9k2T16gS2ZZKMSxKWJJ2wcAs2mzes5g2vt3nx4Ame3TuMFevi0W+d4qWfw69/aA1XXJxAFE6SXpdAhuQ0rTXSkCE51gAEKiKnieiep+9bYYIyOLj/DAWnk2eePcae58DX/CidEXe+9g2vOvnss/vPUsCaXW+R9VatZhFmbQBCEvLP8IUIQoAiUDL8ZmZ7lVJyNuWoEop4wsbIcqRQgGLeRBNHGoInnzrG0BC8NOS+b+OG9UxN5jFNcyZRSAbhXJFOuV886z7mJFDfwisAuwg24d4GIKXcQfCOfidV5q0LIKYtNe6ieWUwCObl/UtTFKA2SQ2C+U0vS7PQ3Rt+V/pBdjNTTWVX+P9dVJ9XXSjktGhdZz6bdn6P89sfUIukBtNEyUghb3AJy9FBfVurhoictpwEuhZaaKGFCL3h9+z1hAzBmN5L0HcOLEM5+pjbGleLnNZCCy3MGS2CWnX0NDg+sMD0d1Ff/WsL0yGyzjc02t0zWOfY1gbHZ+fTR2MnwJcIJiULmdw162zoY2l3N01wfpKbVgq20kTYtgXm0QxB7XxEtBu0HrbWOdbo2gsFcyEWHyboM3Yx3Z/Vc14NMm0/vWFezSpPtghqzSmTbq1zbK7j8QAVzvYayITn9cwj/QgdBDbUjOOzb555VMNAE+fs4fxUUWoqxPsCsIv6hJ4drPxw0OcLapFOq8T/Owut+m+hhWoQYThJqaeVW2Yom0ne8qZtz46ePPSnY6P8Pz/80SC3v3snjjOIXwJTyXEhG3MUKklpZyunLVhB5ez8RKA4o1DkSzlSHe0k020nlFu8aXD/8195/MmJjwwNT3DjzV2cHBvFNaGjLaCsSD9QhUGoujcmhMBQoEoltq3NcHJogmuvacfN5vjmoz5/9Vc/pODB1m0wWZzgpy9Ocvp0kXwe8jmYHINcHgq5gKRiBBE92bId4nECBal4HMMUFItFstkixYJicgImxuHokSK5fJFkcpJLt8EVF0tWdaYwhcWpl8fp7krT3lZEO4o33Ch5Yreiq6vjK1qqtyuh8KVCGGZAwNME4TjPukkoFH2kAaYAy5TE7MSRuG18IWb5X/Bdb0O+WHrzwZPc7h/lLZlO1tgxWL+hxIb1ktWdNqtiLkkL4nEDwxAYhsa0XHxfk0mZqIkDWLgkUgaO6aN8HyEM0GGFTMv9AVDKTeL5AZNQI9COh4eD70LMUJw6MUG6bRWZdYLS5BAxO8HY0AjpeArf95HKp72zG9IZPvHHD/HwN+A1t8CHP/xpnngc2iUk26+ifc1qcMbJOWv5m799At+Dz37mKUrF5+ns6uR/fmEQ04gMToN2uWijwdVXrwIxQiwWAynJ5caQUpfJhkrByKhDLAbrLlrN65Jx7nvgKMKAD34wzrve+jp8b5jJUy9y1SUbuP6a9bzzjnZcwErYoCf52Y+eIqNBCsmJSZeJnM/kuEc2K3n+uVF8F3yfM57P9wzL/HrCTn0n1Z46EUvYZHOT2JaJYRjYdgP3YUjY0oYAT4CQpFJJDr2sv9wWhxtvSrNmlUV7myaZSJMdGsUSGU6N5zh4tMSZM2c4eQzy2YDD1ZaGTAekktDeniSZimOYPp7v4LkKz4WhoRL5LLx0oEShUMK0xkjEIJ2GlA3dXdCehlNDUwiZYu16OHYsx77nn8UU8Msf7OCySzpImGdY1RXHkj66qnFDmf0YtfdK1S0N6DiHj2YpOBmeefYYzz0PCv7p6msu/khbpp2R0Wz9+quEFlVZtREhTSCDMMVhOGEhABGE+RRhiMraNLhakBjSxJByXGmF65hkUtv41qOPc3QQEnE+2WqtTMIAACAASURBVLmtc8/UZIlYLIZaJPJwVZzvRLaZ3VAL9dFLMG/MhOP6jvD/Xla+/zNSMZ9L2Mb7WR4CVn/4XW3tIVro7iPwlfezeHOfXoJ6ichBs/0cke/rbqb9WpGf9nwnp21lWiFsrhtXIVBa7+X8XAuajXokNQj85h9laYhqO5l+DnPZXHYh1X8LzaP1vFtYaegNv6utL95GEDZ7N8E4upjvSR2cPS43ixY5rYUWWpgXWgS1s7GTxp3wQjv/cRqHeOplZauo1UKjRdWtdY4NzjGveqGFKvGXBBOjXuY26Z6Ls2EvS7/DaYDWgulC0IgctpCwbREGGhzPcH6qqPXR2Gl1Pu/wWwzspHnC2ELl+vvDTx/NKdecr3Y3H9RS7eqlMYm4ng3P51n1AocanJMh2EH6aeZOIOshsINmJo6fZ3Gdfj1NnHM+qio2GicixcOFYA8BQbXec7uT1uR+MTBA9T6yGUd1PfW1VxIavde36ulCQjlk3azfZsDBNMaw5Uj5F+X7gZoPILXCLfgkrOSfFez8zU/v9X8h1X2AVGodmdQppK+8ebAmlhW+VGgZhPFUvuKyay77lQP79p94ei//aSw7yu3vXsfI5ChKQGebwJSlsnqa0ApDSFTFTUYEuyAUnEAoCY5kVbqDqYLm2uu7WLM+z4v7cxw5AdlRGHi0BKFSEiIk6LTBqrWQaoPubpPu7k4sQxNPSuIJk0TSxpSKbG4IUKATgInrCPJFj6lsiXxRsW+fz8ED8JMnFetX5XjtjSk2XZTGsix84RIzfLZv6iZ/jcP3Hht/W05lb96w5aIfTGSzZDq7ygS1sxDyaeK2DMl6QT34vgNCYiYkdlyeuO7Ga77s+d6Xn3/++YTv88ZTp3jHiRO8aa9VuGptO2zshM4UXLQhxdr1GQxZYNWaJGdOn6K9PYZtG1iWDZaBnUpRymbR2kd5PlprfDdQjjMMIwh5aIBlg9YK5WsSSYtc0aWtK8F9D0zwR38AnhjikSd+hZ/+9GE2tfu85spN5EeOYAmfWLsNbQrtnuLyy+FDEmIpaF8Nb38DfOa/Qu+v/w3vfN9tnB4+yX//i2/hevBrvwV7noH/8tkJ8CewJbSZcO1rduD5x5BC0NGZBDFJsTSFVgZKB6FTPT/gsBGYDPF4QKCcmhriou613PWbF2PHkqAkxdMHsYRPwnBBGUwcPYSnDVRCMJorMDahKOZTnJhyKRQNXjhYIJcPSIvxmNqXLfFoZyb2iGmkvveqHVcXXjrwcxAeggKuXyAWD0h/juPgOE6ZOFcLhilxfY0UEoHB4OEDN2t427aLYcv2ThLJIpZlMTw0wdSYzUsvTPDzfXDoKKxeDZdthfWrYe3aGLZtY5oGyVSCVDKJkD4+kyCsUIXMpFRMUix45LJ5siWfo6chV4TsJOQL8PTPwJOgpYvQ42zogovWQcfV0JaEbdsnaGsrkk5rTEODmm67AVlGzyTDaisI6xkS1IQBVqqdkaOTjIx75AvdPPLd4+zbD91r+Nw1V7/qE76QTBZKGIlYzdCLMyHRQiG0KOudiYrwxMEPMlR9DM5oFHpx+rHNzFlWnqElvmcyOqq0ZYJpWDw1cITnfgJJiwc71yY/c+zYGEY8HCqMioTCsUNE40gDzObfletlAcS02eEt657L2cPbXLKuwR+seh/NpKtEcM1CeG0Luf+51H9l+pUhUquWf0Z6Na1+kGDefF/Fb5nw/6UKR7kYiOZr8yHALBf6w+9aG+S3EPjL+wh8RbuYn9+5g6A+esLvDMG8eSu1yR/jBP6XiKj2pfDcrZxfoRW3EtxzL837A6thPv6glY6IpLaL2r6PiKi2l8BeB5gfYaiHaRucz3PYS5Xwwi1cMBioc6z1zFtYiegNv2uJYNwWfg4zc/yeK3YS9H09zI1sH6GlOtlCCy0sCC2C2tnoaXB8L4vz8tJPfVWuRuU4l6h3/40WVXvrHBucR1l6CZjjjRDF644mwI0W2+YqA93b5HkLwUonlzSjsrVYqLYTrxF6GhwfmFdJZmKcYEdkvZe6Hlbus6yl+JRh2nFUDf3UJ1ss9ovqwCKnVwv9NE8SaVYdbzF3hfYR9Gv1FDkjLDZBrZeVOU7VUu1qZMN3s/g2PEjgaGyGRPgppkl0/Q3O3UnQBzYKIRohUuubDwaoXp87qU9c6aH2+Dk4z7IsBxq144FFymcX9cOGtwhqS49GfWItW2hGfe1CQiNbbHbsa+F8QSW5oCpRTRHTLjG/CATkq1kCZ5i+RmsL02q/I57I/vznz09cmWovYQCWIWO+rh4GcyUgUFJTaMNDU0KbRRwNG7et/sTJI0PDBw7w2XvvO8Xb37UeJfLEbJO0CVo4CK0D4gp21bSjBXwpNL72MQyLVEKQThuk4gYXrc0wmVVMTLgBwU24SDza29PYMZN0oo1YzMJ1s5imxjJAmhrLcDFMB2lkkTgk24vhcywhhIkghuNCzjEolWJctCHJa64zOXG8xJGDIzz4SI5rr82R7N6MwCSdFCRsxdp1cbpWT5DLe382Vci9ScTj+ELi65kkhhncHQ0gzwphGJyvAInjKBKJFNe86oZCIpF62HHUw6dPDXHixKmdTiH31sNH3LccdLhl73OTiURqkg0bobMDkmlYvyFFLC6wbEncBktqYlYCW4IpwTAVmAJdDiPrg/DQ2kVIsAQozyNmSNAxXnVljC2bxtl6GXzuc1/h4Yeg24affL8by9bYEjA8pk4cJ97dyUc/egmatVjxGKQLYK1n9Pgu/qbfZ+Dp7+J4kIzBZz9zKR/76E04bp6//rtHeebHU3Sn4b1vvwxTZFGqhBYyJDp5oAXSEBhCIqSFkAopRFmdUGsVkpEkfilHPj9FTmu0ayLdFNoTKA2+r9FeO8dPDXFsOMfIBIxPwkQWxkZhfIpSsoMnRyf55rp1fPvaG1/3tG3Y+J5maqqALxUqLJMQuvwso+fdiAQFMJWdwLKTJOIdaK/E5KT/Z91dsO2yTnyRQ5mS8SmX8ZEYjw3kePpHcPWr4f13Wmzb0kbKmCRh+cRiAtsWYTnyCFkEPEzLRUg/KBsSkTZwHJ9ixqfowSWXJik4FvlcnKIbY2y8hC/MgPCFQ0KXSMZd2tpKxGKQjGnSySJ2zKwIaVyDSKNlOd8IVqqd4y9N4uTjjJy2eXLPcYaHYc0664/WrN/45z42XplbZqKRTZOPapGgZp+zmFDKJ2ZjSwH5nObAC0dIWMYLJce/I2EnMHQeq0aZFEFbr0eQqixvFFZ5wWUW0yqYjaBn/R1dU/n7fMo/22KqpVsL0bnzJektxv03g2p5VP6/QJLhLgIy2uz50VKGo5wvdhL4DuaqFB4ppy03GaI//K7nM8owTRSCwH+wJ/yMc7YvJPIF7KT2Jv9KkmG9zfe9TG8U/MvwEy24D7DyNmp3ML2YfyfzU0qrxG6COhhcYDorFXuYXiuoRxzbwfQa2QRn21+lDUS2F30vVLW/kY220EILLZwL9Ibf9Xz/WwjelaL3p90E40nlpxI9Fd87mRvJfjb2UiMkewsttNBCs2gR1M5Go4WWxVrg30V9gtoOVu7OoT3UVqm5m+mQdbNxF7Unb3vnWZYBqjsyqiFDQAL4FMGAPcD0RGdr+Olh7pObT7M8TPGVSmqKkGH5wrnNR7FjqcO2VaZTL687WbmT3wFqP8OPMk2MGQh/66FxaMrFIvVWYrnsbGAO5/Y0cU7kfFpM9BM8l0Z9YM8i57uFhTvjlgIDNLbhPqbbew9La8N9BG2+mV2cWwgcx9E4Osj0GLWT6TFqrjtC72T+5R+s8XuG4N5q9WV31/gdVvbOqp4GxxdrnBigfpu9g1aYz8VAPVu7m9oLHn3U7t9Wsv3OFwN1jvVR+72+j9r1tHtBJWrh3KLegrWWxF2bFAm01ig1TTVTIiDRmK4B0kIkDe3Hk7ecGTr1Qirvr07Ek8TixpqCqzG0rLowrpU6i3Axm8BgUB/zJWxIHainBaEsXYQcQ+k8PoJ0ppuNm7b8ueseHRk8pr74yCMnuf3t2/AKQ2xZY9CRMEG6YWEDIlY1coknFVp4wXFfYZkGtu2T7IZSMs94zOXyLRkUJkok8H0f3ymBcJCyhGkaxNImpmkgpYH2FRoPrX20chE6DDsYEg2F8DAkmLbENsFLaLoEnDQmae9Ismn7BjZfPsp3vlvkpa8c4X3v3kDSkpg6z9p1Bhsugj37eWN8srCla+O6wyVfBPVbl4AQPDEJoCVaS4SW5RCcMaOD/GQRS1oMj02wunsVm9duZOv6zXtKpcKeTFvic0/94LG1R08UXted5rZDZ7j16ee5tq0d2jvHaO+06OiI05W2sSmxriNJytZk4gaxuEbESmD4SCMgDBqGQhjTdlNyNK6rSVmaS7ekuP++JMl1W3h+7z7Mwhivvwlc7ziptA+eh5tzicUhOzVFKV9CmMNYOUF83EHwEn/6ieu54cZn2D/kk2yDd952JZvWphja/zVSbXF++6OdJH9nO7IE3vgoXmEE8IIqFAK0HT4sJ4gXKwQgUWH7UkrhR4pqQuAqi1JJknd8PN9makpRKBpkCwaFouD48TMMnc4zPAzaA0PyrLR4woqze806Hr/6pstPOSoI5VgSJaYKOUzDpm1dBieXRwuJ0HZoRLKshFcOLVmDuyVCu+vuzlBywHFcBg+8vMX3eOPqNYI1G9rQ1gRjWZfhUyUe+KqDcOGDH4ItW226u2LkpkZZv1oQjxlgSdBuEOPU94NvZKBg5tuBnUkNOMQtH9sQJNE4Ok/SlmQSJbQfY8sqC7RGAgIXKfMYQiFMM2ijhsCIWfiAL8BAIVGBzTaCgpGjATktN9rFk4+d4OBpyKzd+O82Xbz+i1r6+CF5CB2vCENbWXF6XnJZWqvqRF8dtkBdvS8UtR5gWC5pCJLJ2Bqn4DIxqikVGDJMfeuWzVu1mysSc8KQxlXgy1B1TuppklJUhrAjlzIkOkVE19llbEDKq1QWLJdcBCp5s9MSFXVQJlmGBLqwmJXZlsekymTqXQ9BV1iNkBXV8uzxK3pmMyJUzyq3Dk1CVjGNpbr/yrJU1n+ltZRJd2JW+auUsVr5RWNDv4vqc90oHGUvwbvnQKOElghbw/yb3SRWicXcpDgf9BPMYQZobjE68vXMR01lNj7ONJlrsOL3DmpHLJm94L6XacJSdB/LhR6miXg7WZhKWiUOE9jEwCKlt5IxzrT6fzM2Fa0tLLXfd4LzI5RwCwtHT51jF6J/p4ULB70ENlqPQ1CJ5eg74cJU/WyhhRbOAVoEtZnooHEnvlgvroM0DvN5Jys3bN4uqk/MMwQDZy/TE60OgkGr3mLsQJ1jjVDLkVEPizVg38/yDMiHaS1ULwSNiKeLEbYtwi7q707cQuDYWImToF3UV3vaQXOKhZXon3dpzi8005/0LlHefWHa9ZyNW1i5pOfFRDM2fF+d47XSXAh6ad4ZDNM7mBcDH2NhfU29/uzjBDbVy/T4tJOgzdcbj1eqA7DW7u9KDCxSXruoTfSP0MPKravzBePUVjXdQvA8e5luIx0E79312t+F+kzq1dN83usv1HpqARtfdeBoGaqnBSvZKiItiRJK2UjpY5smWhgjbe2dN2vtPxNPmBlQTZHbVYUs2+wFeT1bsm32tQ3SlnVW1oUOFuSFVqAVEp9UvI1CtoApu7ns8p1/bx07NHLy5Nh9D9x3iFtem8BSArk2RnvCRBoOvpaAQmuNEAqhdbDgL4wwLGAQSk8KiVAexaki8c40sbY4a5MeGC4h7SG8IRuUh9IKrV2kDtXBlAR8hNJo7YNQqIhZMIMcojCkwDAFMaFwvEk2r4tT8hVD43m6V6/HTp7m6w/n+c53T/CBd60jZkIqpdl2scm+ox7DI7n3rt4o7naV21DRKXAxqbAModpURMzRJlKauI6mo6sN3/OZnJwkFrNIJGMIE3xL8vq3vPU0cF+pVLrPdX2eePyJbdlC4ebho9ySO+Be397mXpuOY3UlYFU6S3sCOttipNMgYyXaOiTp9gSGgHhCYtkC2xSBzfo+WgumJjSxeA7LzuOMDrNxVYIv3HMDZEfIj51AIZCZNJbjgW/ge0bA+zNcDOGjXAfhF3GcAre/eSNvTqSwLMHpI88zdkyzOmOD6TIydhRROkrKasNsS+AVFUoHKntaG6BttNJoncP3DXxloQAVskGyU/nIclE6zpnTeYolk1zJo1gqMXi0wGQOxiYhW8A1DX5mSuuHsVjiCSthPnntzmsOafJoOYEyXXxlAAIhDGKxGFpppBSkUnEmRodRyIDMp42A3DJD3UlVtMPqT38qO4FhxvE9n9Vr2t975sQQ6Q4baStGxiaxjS52757CKcGv/dJ2Nm6cwFUjoBw2XQSm1GjtITxvOtEyS0aDsqYL4CuQPsLQGAYYhiAGAYtOiMAOfSeUmAKkF8joCQG+Ab6JKxT+DDJXZQ8ikdpHiFCVT4DSNhqJwkITZ3iyxOkRyZOPneD0GKzesOm93Rdt2mVYMJWfwkzZzKArCa8in4p7jO5QRR3erLYcHY9U9YQ4i2BUSfqdTSSNwpRGpOLy/7PSkEJjWfZm19HkCqUJV3HzurVrhn0tiCdTAbmpxrP3BJhIlAjyqCxfWV2riuLWzBtkmmQb/V+JKoS2SEHsrKQiwlmlqpuo4MzVuWY2IquIeIt69jFdPc3Z41E18lu1MqgwLVkvgfD/xbz/2bE/zzpHnF2EuuWvtAHtICVYOl/9OkBps0dpe4Dqc8nbCHxRu1leotpW5k9Mm2DlqL/tIbiXfhaHeDYX7AAOMb2g3Usw52rWP7Ij/FQ+g8PMVIiZrfQ2W3VrNiIFrgg94ffW8LNQZZlaOExzqvkXGsaZ3qzdx9LU7VxwD0FZWussrwxsrXOsZQMtrHREm2v7WTyS9HwRhSpfiWuaLbTQwnmIFkFtJpohsSxmBzxA/YGlN5lM1iWo5fPVJ/fLgH5qT9C3EDgOJggmis0MnlXvs1Ao1L0okUhEf/YQPJvlVPSJBuXlwOAy5XOholHbHljEvMZpTD7tBe6qsN+qaGT/S4A91A7zOR9M8MpwvPQ0cc79LF07Hqc2abgSO5ewDCsFS2HDCx2fInLHXIlxC8WnWXj7Gydw3tWyrTuAMQJHaweNHY27Wbk22NPg+F7mUPZG9pFMJhu12TtpkXwWA/VUTXcAzxK083Eav0NeyGPa3dSup/m817ds94JFkrv/5fFAmqkS5RXrcf7jh24iHsshMHCVj/L9gwh1s5vnBSH0e6Qh/k4IcZYCi9IapCwTKMrr8hXKL5W/R9fL2cSA6PxaRINZzJoZZAsNh/ftDxbWw7SFHkX6gB4BLVm/fs0uW9g3jow4X3/i+4XV6nVt5F2LVd0emQ4LgyISB0uCqQKujBEqq0m/IiMd/GPbJiqXR+XDivRclHApKxpVFFAIhV9BjZCAKjMA9NnEAh2E5MTzMYQAXKTQSF1EiiQXdcaZzI+wZa3grW8weeQbHj/Zc4obX7OOmCFZu2YVa9ac4swoN5Umh7Bt+6xQdpV1BzA+6oRljcoskboUniN58gePBX9qHZD1qmAGKUKD1hxCcigW46u2DUqzoVDguuM5bjhxmp1S82pBaTsCOrogmVZ0tOVIJ8EyIJmK0dHWTjpt0N6uMWQJU5rIAphWG1r7CCxKLx4LwlvqOEU8xJQPQiMI5J4C5SGJp0H4AVFKSigNjeOLSbT2sHQCX/mMlQyUAF8myeUkOQXKzaO1hcAgIu9pBVoLtE7gaYOxgmSqoJicyJHPFdDSopB3mZzwyGcdTp4ERVCfCg5q+JmCZ4Xk6UScZ4TghBA+mgIO8JOfPhESI6fbVdA2RGhDoSpemRA5q32EDzIgRqlprlXEowr/lSFRJpNpA2lASrPvxNDNq9bCFVdsxHcn6Uyv5cknT3HkKLztTbB+4zhrukBIGy0dlACFmCHTFuVflsCTGvBDgqwCBNoP7ciLbMcPC+hMXwLgK4Qb/iNLgIsK70GGzCkZKtgF5DQZ9g8eWD5IgcYn55icHnEZzwsOHfP4zmMORZeh5CrzXROM/Hjy2Ag6JKMqoVBIdNghpdpkUIVKAxblHi1sC+X+aXYHFhW7XOPiLAU1rc8+f/a/0eMtK+LNOEtxeuQ0aHmHsBQI76Z0lzw4ljuDLgSEuNgaM7gmTKCyBRuAwg8OiZnlOYtvVofkVi2UZJkYOavLiCylHnFWaBoSKyvLWZW4VksSjeBW/JC4Vx6PZqdbJf96ap9qVh0s1/2X6392+mVWW/3rI0Tlj+pDCNAU+cAHOtDY5XZdWW5fdfPVf31+XGm7l/qbuyKi2mFmKo/TyL82R9xJMIefL5nrrEXcpfbvNTH/jEhCPQRzmuX0n0OwkXBnmP9CCUpbws9i+X2WGrsJ6ry/1gnnwP+7qGjC/mC6zfaxeJsy54KaBNfzvf5bqIudNX7fvaylaKGFGmii/9zDdESYu1h+km9dcnWj8ot60rsttNDCKxotgtpM9DQ4vtiLLf3UVx/YwcoN8TRAYxJAhuYWse5h4QvW0UR7gOUZpPcS2MtyPZuVaAPnE3oaHF+Ktl1PfrdnkfNbTNxFsGC/GOjjlWG7W5s4Z6kX6/tpjqD2SiANrEQb3kWgZlZLjWyx8XkWT92zj8a21axzu29BJVlaLCeRGRqTShuVp4Xm0E/QJ9R7H83Q3Lvj3Vy4Y9oAi/de/3lWLhG1hYVCmEB7HQkVhcLEUEF4SZSPr33Q7APejxS/ITS2EiFzpAa0riCizVpQn73QXv4+qyTNYYYKkS5rfk0fV5XnKZRforuz68cWU68eHcs9tPv7UzfceFMaEeuipPKk0z7JuELgBSFPdTlYIlKDDJkOagY5S5ZD8il0+HdAP9Fq5p0YFRUSkNAiRaXovuV0fYTEI6EDYoNAIMsMPgctFKmEJNOmufKSNRy/8gSHj8D2Swu0ZRIYRpmIuNlUAdFO6gZ1GxWv/KBkcH5I2CkrQDViSkSorqR0QmlOaHho+j65GMGrzkxwhZ5gh/bZrj0uyaTpjsVKpBJDxGywYxCPQToBiSTE4xHRTJOI2cQTNoYhEUgMKYnFLQzDKNe7EBKtFdqfJmkKIZBSBKpaMgHIQGXL1/gKlA+e5+F5HtlsvlwvAPlcEcfR5AuQL8GUG3zn8+CWYHzSQUpGTIPDAl70NXvR8gXg58DLZZKLDol0AkChQ8NVFYQmCO2voi6N8PeIUFJBdwyvUjN+EbOIOuWuQESPPFAQRPgg2Qzg+y5SSsZG8uzbB1s3w8UXx1B6FEPEkdrDDUlNKgwrGkGeRaHyy/lNl7VeOE41g+hTJtyEx2b+T0VoTxV8ZJCRcsDVmpwDw+Mujujk6T1jDPwIUl38ONWdeM/WLZecOvz8C5iz2qxEocuMPhllFBZ+ZtkbtYsyUVfOvJ9m+7sofT/8nh3m0vKxpfalEvwi6BfLx5TAlxrfDEhMgb3PhASUmn4a9Z5K2WxnE5VlRV9WZZwRcpowGfVFEQGrqmKbZoatzLbfSpWx6H9ZJe/oXg0jJFaFTD9VQebSs8pQien8K8pf/dQgTbm89195XeVvlc9Y6OD+pa5vp1H5Z18PHhYTM+9n9vgefO0h8JcN0Fgh/i/Dz16CudUAC5uz9RDMwe5kYeStT7Oy570DTCuh97I8oRT7CeZSgwTrHHeFeS83SW45MUFgl3fTUpupxCDTIXv7CNrbUq/j1CSmtfCKQC2CWqtdtnC+oY9gTOklGEeXegytS0xroYUWWlgoWgS1mVjuxck9BB19vcHkTlbuILAYJIBI8nwxEDkydrG0A/Q9LL8UdOulef5YzrBtEXZRn6C2g5UbbnEP8Hs0H9++Fu5n5YYoXmxsbeKcpSaGDTRxztYlLsNKwUq14f7we6lJah9jcd8bBgkIJ/UI9c3g86xch2AHyxfiPcJAg+MZWipqi4W7mHt46tmIVBouZCzWe33fwovSwnkLDXFfkUQhpMDzoIKr8W/K4DuuIaSSZ5MXtAjC2+loMb2GEo1BfcwIc9fg3GpqOZWL/NHflb+ZQmJgsGbNutPx+PhrxkZH/v4nT2V/ffhMnmt2bMDt9JBdChlXaKEwwvsJlG/M6mHVlgs6CrkpgSDMpGn5xJMBee2SS032/ItHdsLDMhVSFiI1nRg6DtpEiMYh3s4RXgZe3rwpeX/JyVMogFsk6Sou8UtcVPK5TPtsdF0uVpr1pmSVabBJmm5M60D0KxbzsO18WV3KMCAWC1TYREigEiLg2vl+cDweNzBME601ytd4CjxF8LdW+D4opfA9KJXAcWaqGOWnwFd4yueYEpySJie04KDvc0z57E/EOR6zrQPJRCpvxxIcP3GaMglsCTC7zURkldm8QxE2RBFKkKnomA4ZRkFDtrUG1/WxrTinTp3m2DG4+rIEa7q7SMiT4Y76QFExuH5JbmuOUCCLKMAwbEoOZPOSUtHG8VczPurzvSdOcPg0dGf4h7UXtf+GK+LkJsaZ/VzKilo1FM1C+mbTT3NaKTIkmtWmOc3Iv5xvFUJSVJKYDykHGfP5ZZjJJBJCUDQVE4ZAy0rio5pJ6K2I4VmLwxSRpuDsPjhSjFSiRl9fTjPoiP7/9u40RpLzvu/473mqu6fn2J09yOUul8eQEilSokNK0RUIsFaOGSOBAjOIDcNB4lAI7DeOASlIjORNtEICBIENh4JjI4YNZxUDhogg9jIJINhyoKEdyZSoiEvqoMgll7Pk8tiLc/ddz5MXVdVdXX3OTNfM7PL7WfTOTFdXPU9VPd3T0/3r/2OTb313QKydjzXZ1aNgV9LpdMAy+mKiSonqXj9dONB4ycf7adQ9bWk6uNbe15TOVJuDHkV9NMPpLu5/9/FPopvxz+mVU/fPQZUwnOn0Xxoc2BvDuCG1RDIF5Bfjn5PK18nrqIsD1jukTkWvSUzp+JSi59NLO9zObjkTXxbUqax2SpMLCz2lb9ICUwAAIABJREFU6G/ZM5nrV9QdTkouez3t46Qk+31WN++HmyZhSZ1ZaZIx8IgmN4VdElw9oxvnPol8DHqtb3E3OwFMyIqi1yafUPSYmfz+nlTYPAlXnxH3EQA5I6DWMc4fo3m8Sbio0RU0zuTQ7iSc084rwjymyf7BlpQ8Pat8PgX2Bd38b1DebE6NWL6ladvGtKTxwqf7dSwlT3K3W3J9N6e/3Q8GfRorcVG788LU0xr+uLewC33YL/brGD6j6PdUHkHqi4r6vDjh7UrRC+2ntP0XC5/X/g6tjPqAwqomf1xXFL14PWzaGAJqk7GonYVWVzX556v70SSe15/SzX+cMIyXSs6qHCfMCq4roKamtJqdlm7IpnbalbFuMygmEE3v2fsGe6lUVhg6WdvS0aO3qmAL/+zy5cv/7+Ufut+5/M4lfewTc5JmpcMlzUxXFZpG1IiRZJ2Ms0MrC+UrDqf5QvS9cXKhU6FgZaYDzc1N65aj67pyeVOrq061ei1azWtFviS50vCDtte8FLaMrAqaLnvNTpuKtcUXJPuC9+5roTc6efKkNjcrWl1dU2WzcttmNZwPnW6zRscqLR0O13Q0dJq30mFJByXNGqNyYDQtadoYlbxX4ENZ71UwJgyiuJpaoZfzRqFzasiqKqkqqSZp0zutea/lUkmrQUHX5bUs6UrodXl6xmwcPDj39uzsjF9fX1XBBjImiM5TfLG2IDkj74I4FZZJokxYEloZFQjtHQs2WisKqK3KS62mlbXTWlmRThyXjh87po31Zd2xcEQKNyfe9+3yTgpMp8JhaCTZKdVcoI26tLZZ1tKrVS3+5TWtbkqHj+lX777vxO9u1BqanZnTRqW6k0DOHor22TirqZZq5ZatdZZFD+DGRMEt64xcwbUrdllvNWiqXm/6Tz2ZnvqxN7CbSUSO7HX/7Q9m+rY/qD9J8CstvV/pZcZLbsf3RyM/aL7OTEcmuf+TE08ZPJn7wTlFr19s57XdJLCW/J31xSG3nYQbvTrTkjpvdkvRcX8kdRnnw1zpUOCixj8WSZBLqfZOabJBpbwlb+YvilDadqXHQTo4upC6DHv9bFXR2EsuiyKUhsiw1+sXd6sTQE6Sx7xE8nt0QdFj6CGN/l36tLp/f1MkBcCuIaDWMerNyeeVzx8ZZzX8DfSf1f6d5lPafkWYpHLa4iQ7E1tR9Ev484peJJjEp7CejrfHL+kbz25XRkyc1fCKQ49r/wbUpKh/S9r6i3l7UWFwrx0asXxpNzoRt5P39Aw3kscVPWZvNZSS9xhOgtSntfOqZIlkSs8873enFD1ebvWF4t2eEns7To1YvphTu2c1PKB2Kqd234ueUPRYvdXfaauKzsN75fnfmfjrdp7XP673znHCIF4qyqjgoinATOi6qui4vUtmTYxzgbwzajSaajSaCmyg24/f9bsblfo3r797+Q+f+h8bH/n4Jzf1oQ/dqsPzTqVCQ0ePSIdnivLNZhT0CM22Q2rJ1GqDKthsx/T0tN66vqYw9GrUpQMH5nXr0RM6v/RjXb0qzczMfj+wM6pVe2dm7emGHa9fW+1+thqT99GlqzkjGRVl4gBX6L2cS9ISRk5WLSdNTc/olpkZSbocenNZ0ssmsLLWKgikgjWythO8CWRkjJGxUiGIJsV0oZP3YXvKPUnyLmojlGSN7aot5b1TvV5Xo1mXC8Oku+0pNpPAyGa1Ku9tPG1lQYGmJGPlne2b+WiPh8z17fGxxaCISVWGSm+gvb04PJOcj/bVcTWnVtOrUCrIR0HM729u6Ke8K6pUmNVUsRNYLQSFvmPYJqXqxumrMdHjzNDBZDI/dR+QZMpD66MqZ41mSyYoqlQ6oKB8QK9fWtHyqtfaelnPnXtHF16R6nU9d/ioefzkyeMvtGpWU6asVq2usrVRRbSkklzXvdy325F6x3Mn2NZvCuCuWw5Yb1x9Hnna04xm+5y+vY9v5+O7U6eCWnqa0p7gls9ucUCFufRp8nbgEMjubzbLlT1u/Y+PHbi8p+JZpo1k6txB7cc36tfokP6kpgm1cUnCgdXnurc9qf3vGW2p85ftaVfFtVHnb9T4TI2P7L7Fktd2Tyv/kNl23OjBtEGW4sugD0odUvTm96Sf9ydvtJ9JXXdK3WG5/RBau6jOm/jJV0zOikaHHE+NWA4kBgXUntL+fo0S2I5sYC1rIf66lHtPAGAMN8FLxBMzKsSSVwWLs8qUz+/jVE5tT8oZSZ9R9EfaOJ5WtE9n8ulO2xOKfvF+SeP3LetpRft2SvzReSMa55N+ed23z4xY/rBGB5v22mlJ9ygK7IyS3FceF3/kZe3WY8fSiOWjKr3djJ7Q/hzDK4pCcOP2rZ/VeN17tDuh0BVFY+hLGv28RfFtvhSvs98fE/bqOeDiiOV36715v83LaW39+eojeu89/zuj7R0nqv1BkmStlXNOLgzb4ZmbiQulZIpFr5pCV5dMSwcPHnz+noX7/uYdd5R/4wc/8PrGN67olVclYxZ0/dq0rl5vKSgdUCEoKQjsjgNm3vttHF8nmZZkGp3wVaGgej2UdwWtbVTUCKVCUFSrOasrl6OqUuVy+UnvAs1MzyqdHDGu92J998U433XJLh/3YlKX5LpAcTAquSg+N74g6wsyviDrbRx8GF65zsZBiSjwEW8pta4UfW+8bYePjLeyrnPpCvh427f/1ncK6vWcm2TiROPa67W/j6833sk4J+Oi8298FLoyPoq0RcdcUdoquU3q+HsflzWML857uXgseR+v4zo/J9e1L8leJv1LD0Fv1Gw6BXZGLjS6dlVfbTWli0tvyoVWpZJUrUqNMFRpuqy1tbVxBu2uscZoav6wSsG0VpZDLb2yoY3NQ/rR+YrOfu2afnhe8gX7m/c/9OBH7nvgb7xQqbp4nEkFJ1nv+geW9rNUKMgbqW6takGhz6Wkhi3IxfejZPy5zCUZMy4eNyYZT/Gl3Zb3fS/Omfa62WXpeVIH3WbUJbl/+ky/Bl561o+rqg1qw5nMzwP2f0A7zkWXXd//1HlLti3XfW7T7SePK8l67e9T5y+7vvO9/TeZPgxxWjv7u3kiUsfyKe/9Z7z3p7z3i+Mf/7211fHSr//x1xXv/bkdrL+V9Ra990947x+X9Ij33kj6cHz8v+S9/7L3/un4sqP2+3g6vnxJUTXuzyj69b2gzgeO32t/J+4Xi3vdAdwwBr2exmsXeC9aEuE0APsIFdQiCxr9KZw8n7iMqqJ2I0zxtKhO+dDH1Pl007y6Sy2f0e7+Abei6MWM0+rMyf2IBoeWLqrzKaiz2t3KR0+PWL5dw7Yr7f/gwE6MCh3kMW1b4pzGm+bzTE7tT8qSohdfPq/O/Se7fFE8wR1mv9zHJlFN8ka0pP07hpfU6Vv6d9Sg5yTPq/t31F6MrdOKXox9LL4sqNPfZGqPRUWPbftl7A+TPFcZZjGntpcUHbNhz0Ef043/wveo5yG7aVHRmE2P32QMXFRn/J7VjX/cd2JRneN0SvvneX2e9tM4vXEZqSGnhnHyfUq3hDf8x+Pi6TGNk7GhjG0qKHhJoSQjUyjo0b/76V9/8sk/+9N33tZ/rm2uf+TNiw099MAtsielWuWajh1wmi46BaWSjEuF+Aa8ee39qApRWxAll+IKT04yBZWKB3T93Zp8OK3l604tSSfvOqk3Xm/olR9LxZK+c+Dg9DObG5s6cOBA3JcoaGb6TOWWfZPXJBV9fPKf6b+72V303d/HtZvaV3vTyUukh5r1Vt5byXtZ59sVwYL4NoGzckYKvItvn1RJS0JuNvpeth02ssbIGK/AWAVJhSvnJGe7KqhZ7+Pp82xPhTjvnZxz8qEUFUnqTJ0YiYJoBd9QEoCUnIw30aHxthN/i1JsMiY+IkmALS6+ZExq1sVsxSkTHa922Ca+oTedolhe6Qp3vit0ZYyJQ3HJ0rh9HzU/f/Co1tYrmj8wr0d/+hPPPPvMt5+98Gr9Y6+9/3XdeceCCsGSrl+7plbzgFqlMJrKVKYdNJzQ1IBblkx7uHZpWZWqtFot68qy03MvvaXzr0ubob5XKuvX7rn3/d+Sc6q1Kjpy5JBaYU0uCR/KRuPamzhq2B3oib52t9tvqshJ6ips1We5TdXOahmrzZJV1dtsnTNJVqFtKVRLcmF73A6qCLbdqU7TFbn6hf1M5j4/sCJZXsdzRLtK9X87kl+R2cptg9qf9P4Pmvo0uzwZx+nxmzwGWD94/R1OD72k6O/m0/Fl2Gvoebgo6Yz3/oykpf0QONsq59zoGw0RBEH7Ocl2tjXB9c/F6y8OuOkh9b7msxAEwUKm/SWlXgMKgqDnugl5RJ2p1pK/oSbdBoD++gXULmr/vxcDAMBNz9yIf1RN0uzs7I7Wr1QqQ5fPRFNH5GZU+zuVd/9HqVarQ5dPT0/vUk+2J+/xsdfjb6/d6Md31OPvqPG/Uzf7+ADyxO+nfNvPW96/H/Z7+3nb6/3b6/Gbav/UiE2d09aDnI9oeAXWpUqlsjRsA/vw9/+pEcu7jtNej4/Nzc0drX9T8yv6ws/9LU25d/suDgOr1lSgZtBnVZ9MyRi2v48XdN3OxgGZvs2n3vwe963Pfpm5bAig057V7ccXZOVkgk2ZoClrFYVszIysGvr4J96verUi42f1lT88++v1ik7fdVLTDz4oPfzQUR0sL+vAnNfcTEnlYkGFwPX0NpSX5BTKR1WZbCfENIxrTy2YPha2vQ+Bb7U/odiSVcuUVJ6/RS+/uqJm4w79xV/8WOsb0mc/+yn95Z99U6+9IblpPfDgg/e9VN9wqlarurz8lrpOzRZfTkqCLX3/DhoQUktu6rx62s4GIG4/fotC1+xU9skkxW47cSJuKw5mJVXBAqvARtN82iBQYDsBNWOMrPUyxiooRIPXh04+FYBLtuWNVeidjO0eWd63oik+G025qAxf1/GIgoNO7169nlqpIGOKXdNFvvXO5a5jlYyIIEi2F39NTV2ZZkxSAar79sl4SYIlPm4je1/L3nVNvK4zkpfRBx74sGoNp6mpKa2tXNHVq689UN3Qi3fcLZ069VE9+dXv6uC09Pd/ZloP3jul2aAmo1o0q6GRnAry7VHaO95dZtx471OhmuH3j/QZaU+/agM5RVOqGlfS8tWG3nm7oVeWmnr+R9K7VdXslE7/wj/5x//x3dVVvf7qq2rUqvK+pWLQmQZWcvLG6vU3L3VvX92BwKxBAbWdT/EZByAz13rZweEhX5B8qacN+WQdJ1OoSmr17XNWv8dpGzfqMss6U4IO32j28aOnjWQKWqO+y5M6itlxNLYk6Tro9MQND2w/7n/POE52e0QJvmRy6Env/zgBSeN7z1/PFJ/eDN3WsPMX+kN68k+WFQ4K3XkpVEHOl5KrDqnzgZOfHb0H27Kq6EMrZyWddc71VOLaimazuaeV1Eql0ugbDWGt3VHAbL+vXyhMvIbDIUVj59N9ln1OmYDMqNeXbvT37/bh359dbvbjf7MbMr5W1PuB1H+gTCGQ/f76Gt7bePwEcLN6zwfUAAAAAADATjUkX5F8q//i/nMb3mBsXGKqpaTKVWdqxxX9ys8/rMDU2uGpwOgOI/07WT0eGOlTn7C65ajRsaPTmg7qOjhXULngNFMqSi6Ud05h6OStkxTKW8nYuFpW6tilX8Vph4p60ijdQRPTcDJVKbCSnQ2k8pyuVayWN+Z07oV1fWNxRQ/cP6vaRk2bK6Fqm/qlYkF/ZK2kMAo1OUktG8/g1udcZl9eSgJNSaCht49J5/oe7E6AJ7V+O7Dm+lT46RN+lLZR0SkJZ23j5TKfHufbaFfq5F+y/Q599zFM5++SUJpJVUNLphT1rrtK2iADw0uZ5dnbuHjbtlBqB9ZCNVWYMqo23C81W/rKyZNlle2sXn3pun7mlPSRD0nHj0glLwVOUtHIm6IayagxTkFmYJhMMsj7cGhArbLpVShKU1MlGWPUarYUeiNbmJIKM3rr8rIKM/NqOOnChWWd/7HTlSvS1WtSeU5nnNO/Db3ecMbKSwqMkeRkjI17lilVZ3sjr90hoe6AUeoIRtf3Jo56ttd9AJKTHgfSRpQmzN7/TPsxIn4cc30CakpCsq34cclFAQ/Tb3vZDsb71a7YN3x/usa2l3qOVxwIHdROT0eSwNjA9vuX9WyP7UyQ1dsR56N3SyPaT3QqGUY3jCsXZvrfu/+2a/22be5/7/Hvf/4GFUNt3xvaAbnx99+rpFarHIUk+9yXm/6I/vvZ82r6vm/SHlKn4m/ydbvV459WVJlrUdKi915JMC3p/1bCUclts9NI7sV7McViccvrpPsfVxiTc062z2Pdjb7+GMdnQb3V+5JKTKf73P6MBlf6W1XmA0e8wQ9s35AAT/aO8xVF1Ti7EFADAGD3McUnAAAAAADYoZJkSjdBCG2EgftnFWpGQVwRyhnJSJckfU5evx0a/Zv/+efu5+6+U3rfwobed+ecjvtpHZiWjC1oqujlw00Z05Rk4ndUQjnn26Ejk8x12TV3X1wlraesj+sKqQVBQYVpK9mCVLRymtbVK2tab87pynJdpiBdWNpUYKSS0S9PTeuPAifZOJzmfTSZqZzUlPqGr3oOTZKriH9MquO0cwoj3m9N1vPxfy61TmB6gxKDChClrx8rrLbdgFmyzjbWd6lZIZP3zrtOc2oavWw3pdQ++k6ltPZtXCc41xVCyfTBxNtph76STWYChklYMUitZwMpaDVkjFFovWSlZt1resr+N+dd6dKl2u/PzzbkJF1ZlhpuXm9fW9XCsaJUmpJb35CmTWpsWMl2TzEq033+Ou/XR1Okuq6FRjOzgawtyNqoEp3zBTUaUnXDqupCtfxtuvDKis6/tqkLr0vrq5KM/sQV9B9qob5rTHI6XXysUhXz1KloNaik1oiCWPuObYduu5m4qqOLp8T18dSvPhtS66ms1X0AnEuCSv3b90plq+L/k5ClJIVh3LeeDQw40H5U+/3Xa6+WBKuSH0PfDmOOJ9t+dmrf7tu1998kj3nZ/U/fqdPbn8z+jzr+7aDeoECxOo9j3vRrf9j+11U09cFBdjd0GuAVdSqdpZ2Kvy7El0EW420MnbY+CQhttXpXNli0V0Gj7U7xmfS31WrJWqswDEescXOtn7Io6e7MdXdL+qKisZMefwsaPg3tvKLxubjdzgAY6VTq+4uKgqRn9qIjAACgFwE1AAAAAACACUtVnPqepJ8/eFSffOdd/dprr+sfPTu7oZ/4YE233z6nO24vam6mqfmppsrFpkrFgryPEm4+DiwYL1knGRnZ1Dv4ge+TZurDWiNnAoXeqlYzqjmn4uxxXX55TS/+sCrnpUpdr08V9Xh5Wt8oFQpqVlrtUFMUUYmn2jT9g15JX9sygYL2Otl1MyGkflcrCaQlIal+77UPCr6k+jHyLfps//t2ZvLrd6on9bkuWWR7p9lsS2d3fKe5MLVN3/5vQJfi9Xrevk8qIrmuH9vrB4qCjIGXjPEKvFRwUqUpKXQ6VLZ/sOncK42G+0p5Vne9+LJ0+7FQH7jndi29taaD01633HpcreZ6HJKK2/G946wr85QJzqUPhbVR0qXlnFyzrlZYktNhrW06Xbm+qeXVll565U299bZ09bpkivrjYlm/XZgKnrGFQPV6Q84NDyO1u5LcxmUOVL8DnNIzRWLOBgfmhgftfDuYlsT0TPs+FQWqthd8GdS/fuc8fY5HhUzzPJ7pwNak2+/Z/1QeLb3Lee3/wOPf3Z2B++/jdZ3pP9Zsan920s8tWJz0BpNKaNsJme11BaztBtQSSTW57W7rBl//cfWG07LL0wG1x7baAIBcrCoKpj2xx/0AAAAZBNQAAAAAAABykoQrHnrog8+sr288s7y8+u8319d+5a+fa/3C4YsrJ44eXdGdJ4zuPCLddqSoI0cPaqroZAstGdtSoFBeoYyPptezzsoYE33fnt6vf8gkabvhrKpNp0rNqFIvarNe0JuXN/SdZ69pqiyVpwu/U6m1/lUgVb2RGq2WbLZCktSuYhVKvQGczG23/H78FgILZrwZvrq37fvsz7jtD67eszvrj5Ls3x5lIGwcSktXy5s2UqMutbzT7LQWQ6sHbKDfePeafvVbz2yoVrH64P0nVDZOV1fWdHCuJKNGZ5vG90Sm0qc9mRLTxRULvaxcPOVuKywqbBrVmk71Wqhao6RLb67oypWa3rjU0pWr0saG3raBnly48+gf3HXvvT/8zrlnFbZCNeMKO+NXypqMbBBrq+vuvAPjhTa8j5KM7YpZ2Upc7Spc/Qf9qDEaLU+t66NLMsOm7/vA07mub3h12PYH9i+T9jTZ5QO236dP3dsf0f/sN0lwLB007Vpnl/d/wPb9wP51rd7ef9+1xO/o4W83pKf73Ouw2XZMos/tc7fNbd3A658esfzQiJ8B7L5ziqoZruxxPwAAQB8E1AAAAAAAAHJivKJ375vzmi3Pa/bk0Re9bXzhx+d/9K+nZmd+8dL1zV988SX/t4/NKPjAglMQXNXdC4d04sQBFUpVtZoruu3EvIxpSL6lIJ57MPBWgbGy1spKMnGJGhOnVTY2K/JJeMd7XV8N5e2teuOS0fd/8JYuvSFVW/rh/DF94cGH7/769777qpyLK6XF1aOsUZQKcvFUjlLPLKOdHd3pgdrh+ju11/3Pe/9z2r6PKyYVJBW85MNOgDAoRGHGZkN6+KMPVpdX1/55WL/81NUrrf/0rWfXPrSy5nXf+w+pPFXTnSdCNWoVTU1JB+am5VtOQVKULA5kBsa3f15fb7b3KTSSLZe1vh7KqCyrOb3z1pouX6lqda2lC69WdOWaZAOFQVH/Jyjoj+974NhX5+bm6wcOzCn0TVn1qR63rQPSPz05qPJVupKa8fHq2XJ3krInMDtTY7ZVNypBOinx/mb3L6qGN34ZQZdNBGaPY6YCV2pNSaYdWLSZ23eM2H7Prbv7b0aEWnzc/04FtDFTtCZqJzslar8eRf1Ifk6Hkne+/+2KZu1A2tbO38jjmx0fPe3ceKEvvGcMq57Wz9IYtxk6pSyAHSOYBgDAPkZADQAAAAAAICc2rgAUuCjw5Xx0ed+9H6gXZ2bOHK34MxfthTtrq6t/74WXWp810k++dGHl4LHjKyqVpPfdW9bSW++qPC2VpwLNzs6oXCqqXCxJUhzacXFAzclYI8kpCGZVr9VVqVW1UZNeOh/q6rWrevtN6fp1vX34SPE3P/aR+37r8G2B3l2+EuXQ4vRZuzBScpG68wPZ68bNFwy6zW7lE3ba/l6vvx+33w62RN94a6LAZJTMjKqgealerWt+7rA+9NCJr4ct89C55579F995fv1ffvvc+ok775A+/JB06KB0+FBZVTcjuSguZk0ytWRcLTD+uWCnVK/XVa1WtVmTrlU2deW6VAhqeuPisjbXpc11SVarrVB/5Wb0v+YPHfna7cePvXHk0LxsGEq+Jeda7TCXUWeawj1FXqfHqFOykwp0W9UbBsy//VH5tf3S/r64/wCT9bykh4csX8r8fFbRlILzA27/ZRGeAQAAwHsYATUAAAAAAIAcWB+FGYy8ilqTfFSdzHupVJqStwUV5yRz761v3Hvnx37P1Wu/9/U//7+HSwdLn3x5qfGTCvXx196oPeSlY8WiVJ4KNTu7rnLJ6PDhaBYpKyOZlqxtSsbFAR6nVhiqXg+1WZWqVenVC9LUlJ6bnZ39yp0LU7//gQfurxjbVFhv6tDcbTLhZVlnZY2VvJVxceIgntIvmvvNx1+T+dyyU4sOm5QxffusQevv1E7b3+v1R9nq9gf9vP3tWxelqUJZOSsZGYVWasorNE5eLvrniqo1nMJWVRubDf3EIx/9rVcvnP8v199d/eV3ruuf/u+v68O33SrNH6zpwIFQ06Vi1KRPwmOu6+ew2VC9LlUr0npdulaRVjcleV3xXj8ol/Xtg0dLf9VqNf760b/z6Mqbl96SlVdRXnW/FlUfdD4KkBq7/WDNuJWyMpLAT16hon4hqom3McEQXXZb/Q7LsPbaFeh26Ximz19cZHJH7XcqinVvv+9t+tjp/vcc/37tD1k/vf9JKBu4SZyW9KdDlp/J/Lwi6ZH4+k+nrl+Nt/XExHoGAAAA3IAIqAEAAAAAAOxIQU1/sOsaIyPrnYycrHdqKAqUyRfVklWj2lJ9M5QzTrZ4TDV3SNNzM/rsP7x/ObCFrzUa4dc2N6t69pnvlJvN2gMblc0HVdHddtndJ+lEpbJ5i6Sj1pg5o1bZBFHFqcBKxqpljKnI2jVjzOvOl7994OjdX1+4+/5vzh+e1vrGdW3UJedrKhStyuVpNfxlyQXy8ZSh1kSJByOj0Hh5eYXeRd9nkzxd07Wlrx8WaUiF2watv1M7bX+v1x9l3HBUz2yPY7YzRv8DeQUyqttAgfHy1sgbKYwDas5ITk7V8JgCW5QpBirNGVVDqzvuOVa55/7gy41m5cvnX3rxUxst/+jbSyufMEZ3KWwddN7PSCp47+V9GIUmpZqkDRvoujHmmqS3Q5XOu9L8UnF25sVms/nSoz/9U7VC0WqqXJRTqHeWr6k4e5dcq6F6sy7TiqfIlWRlowpv/rDCJKTmOvttbVLBzcZfx08AjZy1UYrPTWdCTufjc+Ntn0BSp1+92x5+Tr0ZPlZG9XXLeaOuFbYXiBzr+LWbi9pwA5vqE64coypYZEj/u4KGdktBwE6QK7WW6Zz/3v0ffA73bP+T9ne0/8PbaOqQnL++hS0DE3VW0uck/dc+y74sabHP9UuSTkl6TFFY7Vx8u76V0/yIKYQBAACAm4nhCTAAAAAAAMBONCRVJLVS10WVzPpLhwWGVd3KVigbxI24jZVUUqfWT/aS3GZIiCV5/chocHBpSwGtMdbfqZ22v9frj7LN6l2TCaj1kw7aDFpmM1/7VY/bTiW57PjNbi97HxknPLhbtlnRbuxlW2kjD5PYv52uu5P9z7v/+/1ebf0DAAAEPklEQVT87/X5K0h+Tl2fs2caUeyi2dlZKQqbfT6+akVRJbRFSapUKnvSLwCjJVPDD8L74wAA7D4CagAAAAAAAABuWi4TstntCFrWqMjPyP4lVd6S913NeNsdvwfD7f3x21kPtlbrq1/7O7PT43fj7392+uAtboCAGnZRHFAbiIAasH8RUAMAYP/Z69cTAAAAAAAAAAAAAAAAAAA3KQJqAAAAAAAAAAAAAAAAAIBcFPa6AwAAAAAAAACAMTHFIQAAAAAAuMFQQQ0AAAAAAAAAAAAAAAAAkAsCagAAAAAAAAAAAAAAAACAXBBQAwAAAAAAAAAAAAAAAADkwnjv97oPAAAAAAAAAIBxJC/nmj3tBQAAAAAAwNiooAYAAAAAAAAAAAAAAAAAyAUBNQAAAAAAAAAAAAAAAABALgioAQAAAAAAAAAAAAAAAAByUdjrDgAAAAAAAAAAxmT2ugMAAAAAAABbQwU1AAAAAAAAAAAAAAAAAEAuCKgBAAAAAAAAAAAAAAAAAHJBQA0AAAAAAAAAAAAAAAAAkAsCagAAAAAAAAAAAAAAAACAXBBQAwAAAAAAAAAAAAAAAADkgoAaAAAAAAAAAAAAAAAAACAXBNQAAAAAAAAAAAAAAAAAALkgoAYAAAAAAAAAAAAAAAAAyAUBNQAAAAAAAAAAAAAAAABALgioAQAAAAAAAAAAAAAAAAByQUANAAAAAAAAAAAAAAAAAJALAmoAAAAAAAAAAAAAAAAAgFwQUAMAAAAAAAAAAAAAAAAA5IKAGgAAAAAAAAAAAAAAAAAgFwTUAAAAAAAAAAAAAAAAAAC5IKAGAAAAAAAAAAAAAAAAAMgFATUAAAAAAAAAAAAAAAAAQC4IqAEAAAAAAAAAAAAAAAAAckFADQAAAAAAAAAAAAAAAACQCwJqAAAAAAAAAAAAAAAAAIBcEFADAAAAAAAAAAAAAAAAAOSCgBoAAAAAAAAAAAAAAAAAIBcE1AAAAAAAAAAAAAAAAAAAuSCgBgAAAAAAAAAAAAAAAADIBQE1AAAAAAAAAAAAAAAAAEAuCKgBAAAAAAAAAAAAAAAAAHJBQA0AAAAAAAAAAAAAAAAAkAsCagAAAAAAAAAAAAAAAACAXBBQAwAAAAAAAAAAAAAAAADkgoAaAAAAAAAAAAAAAAAAACAXBNQAAAAAAAAAAAAAAAAAALkgoAYAAAAAAAAAAAAAAAAAyAUBNQAAAAAAAAAAAAAAAABALgioAQAAAAAAAAAAAAAAAAByQUANAAAAAAAAAAAAAAAAAJALAmoAAAAAAAAAAAAAAAAAgFwQUAMAAAAAAAAAAAAAAAAA5IKAGgAAAAAAAAAAAAAAAAAgFwTUAAAAAAAAAAAAAAAAAAC5IKAGAAAAAAAAAAAAAAAAAMgFATUAAAAAAAAAAAAAAAAAQC4IqAEAAAAAAAAAAAAAAAAAcvH/AT2j4WlPKNRKAAAAAElFTkSuQmCC";

/**
 * Calculates the exact fractional column anchor (tl.col) to center an image
 * over a given set of column widths in an Excel sheet (at 96 DPI).
 */
function getCenteredColAnchor(columnWidths, imageWidthPx = 230) {
    // Excel column character-to-pixel formula: Math.floor((width * 7 + 5) / 7 * 7) + 5
    const colPixels = columnWidths.map(w => Math.floor((w * 7 + 5) / 7 * 7) + 5);
    const totalTablePx = colPixels.reduce((sum, px) => sum + px, 0);
    const targetStartPx = (totalTablePx / 2) - (imageWidthPx / 2);

    let currentPx = 0;
    for (let i = 0; i < colPixels.length; i++) {
        const colW = colPixels[i];
        if (currentPx + colW > targetStartPx) {
            const offsetInCol = targetStartPx - currentPx;
            return i + (offsetInCol / colW);
        }
        currentPx += colW;
    }
    return 0;
}

window.generateClientSideExcel = async function(students, metadata = {}) {
    if (typeof ExcelJS === 'undefined') {
        throw new Error('مكتبة ExcelJS غير محملة');
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'منصة رائدة - مشروع مؤسسات الريادة';
    workbook.lastModifiedBy = metadata.teacherName || 'الأستاذ';
    workbook.created = new Date();

    const FONT_NAME = 'Calibri';
    
    // Style Definitions
    const fontHeader = { name: FONT_NAME, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    const fillHeader = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }; // Slate-800
    
    const fontMeta = { name: FONT_NAME, size: 9, bold: true, color: { argb: 'FF0F172A' } };
    const fillMeta = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    
    const fontTitleLg = { name: FONT_NAME, size: 13, bold: true, color: { argb: 'FF0F172A' } };
    const fontTitleMd = { name: FONT_NAME, size: 11, bold: true, color: { argb: 'FF334155' } };
    const fontText = { name: FONT_NAME, size: 9, color: { argb: 'FF0F172A' } };
    const fontBold = { name: FONT_NAME, size: 9, bold: true, color: { argb: 'FF0F172A' } };
    const fontNA = { name: FONT_NAME, size: 8, color: { argb: 'FF94A3B8' } };
    
    const alignCenter = { horizontal: 'center', vertical: 'middle' };
    const alignRight = { horizontal: 'right', vertical: 'middle' };
    const alignWrapCenter = { horizontal: 'center', vertical: 'middle', wrapText: true };
    
    const borderThinSide = { style: 'thin', color: { argb: 'FFCBD5E1' } };
    const borderThin = { top: borderThinSide, left: borderThinSide, bottom: borderThinSide, right: borderThinSide };
    const borderHeader = { top: borderThinSide, left: borderThinSide, right: borderThinSide, bottom: { style: 'medium', color: { argb: 'FF1E293B' } } };
    
    const fillBlock3 = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } }; // Green
    const fillBlock2 = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } }; // Yellow
    const fillBlock1 = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2FE' } }; // Blue
    const fillAbsent = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE4E6' } }; // Rose
    const fillZebra  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    const fillNA     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };

    // =========================================================================
    // Prepare Embedded Logo (Zero Network Fetch)
    // =========================================================================
    let logoImageId = null;
    try {
        if (window.MINISTRY_LOGO_BASE64) {
            logoImageId = workbook.addImage({
                base64: window.MINISTRY_LOGO_BASE64,
                extension: 'png'
            });
        }
    } catch (e) {
        console.warn('Failed to add Base64 logo to workbook:', e);
    }

    // =========================================================================
    // SHEET 1: لائحة التقويم الفردي
    // =========================================================================
    const ws1 = workbook.addWorksheet('لائحة التقويم الفردي', {
        views: [{ rightToLeft: true }],
        pageSetup: {
            orientation: 'landscape',
            paperSize: 9, // A4
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 2,
            horizontalCentered: true,
            margins: { left: 0.25, right: 0.25, top: 0.3, bottom: 0.3, header: 0.1, footer: 0.1 },
            printTitlesRow: '8:8'
        }
    });

    // 1. MUST set columns geometry first so ExcelJS knows exact pixel widths
    ws1.columns = [
        { width: 6 },  // A: الرقم
        { width: 16 }, // B: رقم مسار
        { width: 26 }, // C: الاسم
        { width: 11 }, // D: LTC
        { width: 11 }, // E: CTC
        { width: 11 }, // F: LP
        { width: 11 }, // G: CP
        { width: 11 }, // H: LTM
        { width: 11 }, // I: CTM
        { width: 20 }  // J: اللبنة
    ];

    // 2. Add Logo on Sheet 1
    if (logoImageId !== null) {
        ws1.addImage(logoImageId, {
            tl: { col: 3.5, row: 0.1 },
            ext: { width: 230, height: 44 }
        });
    }

    ws1.getRow(1).height = 36;
    ws1.getRow(2).height = 4;

    // Title Row
    ws1.mergeCells('A3:J3');
    const titleCell1 = ws1.getCell('A3');
    titleCell1.value = 'مشروع مؤسسات الريادة — شبكة تفريغ روائز تقويم القراءة والموضعة (TaRL)';
    titleCell1.font = fontTitleLg;
    titleCell1.alignment = alignCenter;
    ws1.getRow(3).height = 22;
    ws1.getRow(4).height = 4;

    // Metadata Rows 5 & 6
    ws1.mergeCells('A5:C5');
    ws1.getCell('A5').value = `الأكاديمية: ${metadata.region || '—'}`;
    ws1.mergeCells('D5:G5');
    ws1.getCell('D5').value = `الأستاذ(ة): ${metadata.teacherName || '—'}`;
    ws1.mergeCells('H5:J5');
    ws1.getCell('H5').value = `المادة: ${metadata.subject || 'اللغة العربية'}`;

    ws1.mergeCells('A6:C6');
    ws1.getCell('A6').value = `المديرية: ${metadata.directorate || '—'} | المؤسسة: ${metadata.schoolName || '—'}`;
    ws1.mergeCells('D6:G6');
    ws1.getCell('D6').value = `القسم / الفوج: ${metadata.className || '—'}`;
    ws1.mergeCells('H6:J6');
    ws1.getCell('H6').value = `السنة الدراسية: ${metadata.academicYear || '2024-2025'}`;

    [5, 6].forEach(rIdx => {
        const row = ws1.getRow(rIdx);
        row.height = 18;
        ['A', 'D', 'H'].forEach(c => {
            const cell = row.getCell(c);
            cell.font = fontMeta;
            cell.alignment = alignCenter;
            cell.fill = fillMeta;
            cell.border = borderThin;
        });
    });
    ws1.getRow(7).height = 6;

    // Table Header Row 8
    const headers1 = [
        'الرقم', 'رقم مسار', 'الاسم والنسب',
        'طلاقة قصير (LTC)', 'فهم قصير (CTC)',
        'طلاقة فقرة (LP)', 'فهم فقرة (CP)',
        'طلاقة متوسط (LTM)', 'فهم متوسط (CTM)',
        'اللبنة المستهدفة'
    ];
    const row8 = ws1.getRow(8);
    row8.height = 28;
    headers1.forEach((h, idx) => {
        const cell = row8.getCell(idx + 1);
        cell.value = h;
        cell.font = fontHeader;
        cell.fill = fillHeader;
        cell.alignment = alignWrapCenter;
        cell.border = borderHeader;
    });

    // Data Rows
    students.forEach((student, sIdx) => {
        const rowIdx = 9 + sIdx;
        const row = ws1.getRow(rowIdx);
        row.height = 20;

        const isEven = sIdx % 2 === 1;
        const isAbsent = (student.status === 'absent' || student.final_level === 'غائب');

        const stageLTC = isAbsent ? '—' : (student.stages && student.stages.LTC !== undefined && student.stages.LTC !== 'N/A' ? (student.stages.LTC === 1 || student.stages.LTC === '1' || student.stages.LTC === 'متحكم' ? '1' : '0') : '—');
        const stageCTC = isAbsent ? '—' : (student.stages && student.stages.CTC !== undefined && student.stages.CTC !== 'N/A' ? (student.stages.CTC === 1 || student.stages.CTC === '1' || student.stages.CTC === 'متحكم' ? '1' : '0') : '—');
        const stageLP  = isAbsent ? '—' : (student.stages && student.stages.LP  !== undefined && student.stages.LP  !== 'N/A' ? (student.stages.LP  === 1 || student.stages.LP  === '1' || student.stages.LP  === 'متحكم' ? '1' : '0') : '—');
        const stageCP  = isAbsent ? '—' : (student.stages && student.stages.CP  !== undefined && student.stages.CP  !== 'N/A' ? (student.stages.CP  === 1 || student.stages.CP  === '1' || student.stages.CP  === 'متحكم' ? '1' : '0') : '—');
        const stageLTM = isAbsent ? '—' : (student.stages && student.stages.LTM !== undefined && student.stages.LTM !== 'N/A' ? (student.stages.LTM === 1 || student.stages.LTM === '1' || student.stages.LTM === 'متحكم' ? '1' : '0') : '—');
        const stageCTM = isAbsent ? '—' : (student.stages && student.stages.CTM !== undefined && student.stages.CTM !== 'N/A' ? (student.stages.CTM === 1 || student.stages.CTM === '1' || student.stages.CTM === 'متحكم' ? '1' : '0') : '—');

        const finalLevelText = isAbsent ? 'غائب' : (student.final_level && student.final_level !== 'غير مقيم' ? student.final_level : 'غير مقيم');

        const rowValues = [
            sIdx + 1,
            student.massar_id && student.massar_id !== 'غير متوفر' ? student.massar_id : '—',
            student.name || '—',
            stageLTC, stageCTC, stageLP, stageCP, stageLTM, stageCTM,
            finalLevelText
        ];

        rowValues.forEach((val, colIdx) => {
            const colNum = colIdx + 1;
            const cell = row.getCell(colNum);
            cell.border = borderThin;

            if (colNum === 3) {
                // Name
                cell.value = val;
                cell.font = fontBold;
                cell.alignment = alignRight;
                if (isEven) cell.fill = fillZebra;
            } else if (colNum === 10) {
                // Final Level
                cell.value = val;
                cell.font = fontBold;
                cell.alignment = alignCenter;
                const strVal = String(val);
                if (strVal.includes('اللبنة 3')) cell.fill = fillBlock3;
                else if (strVal.includes('اللبنة 2')) cell.fill = fillBlock2;
                else if (strVal.includes('اللبنة 1')) cell.fill = fillBlock1;
                else if (strVal.includes('غائب')) cell.fill = fillAbsent;
            } else {
                cell.value = val;
                cell.font = fontText;
                cell.alignment = alignCenter;
                if (isEven) cell.fill = fillZebra;
            }
        });
    });

    // =========================================================================
    // SHEET 2: تقرير تركيبي وإحصائي
    // =========================================================================
    const ws2 = workbook.addWorksheet('تقرير تركيبي وإحصائي', {
        views: [{ rightToLeft: true }],
        pageSetup: {
            orientation: 'portrait',
            paperSize: 9, // A4
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 1,
            horizontalCentered: true,
            margins: { left: 0.3, right: 0.3, top: 0.3, bottom: 0.3, header: 0.1, footer: 0.1 }
        }
    });

    // 1. Column Widths
    ws2.columns = [
        { width: 16 }, // A: مستوى اللبنة
        { width: 34 }, // B: الوصف البيداغوجي
        { width: 14 }, // C: العدد
        { width: 20 }, // D: النسبة المئوية
        { width: 20 }  // E: الملاحظات
    ];

    // 2. Add Logo with exact calibrated center anchor
    if (logoImageId !== null) {
        ws2.addImage(logoImageId, {
            tl: { col: 1.67, row: 0.1 },
            ext: { width: 230, height: 44 }
        });
    }

    ws2.getRow(1).height = 36;
    ws2.getRow(2).height = 6;

    // Title Row
    ws2.mergeCells('A3:E3');
    const titleCell2 = ws2.getCell('A3');
    titleCell2.value = 'التقرير التركيبي الإحصائي لنتائج التقويم التشخيصي للقراءة (TaRL)';
    titleCell2.font = fontTitleLg;
    titleCell2.alignment = alignCenter;
    ws2.getRow(3).height = 24;
    ws2.getRow(4).height = 6;

    // Table 1 Header
    ws2.mergeCells('A5:E5');
    const t1Header = ws2.getCell('A5');
    t1Header.value = 'أولاً: توزيع التلاميذ حسب لبنات الموضعة النهائية';
    t1Header.font = fontTitleMd;
    t1Header.alignment = alignRight;
    ws2.getRow(5).height = 20;

    const headersT1 = ['مستوى اللبنة', 'الوصف البيداغوجي', 'العدد', 'النسبة المئوية (%)', 'الملاحظات'];
    const row6 = ws2.getRow(6);
    row6.height = 24;
    headersT1.forEach((h, idx) => {
        const cell = row6.getCell(idx + 1);
        cell.value = h;
        cell.font = fontHeader;
        cell.fill = fillHeader;
        cell.alignment = alignCenter;
        cell.border = borderHeader;
    });

    const totalStudents = students.length || 1;
    const countB3 = students.filter(s => String(s.final_level || '').includes('اللبنة 3')).length;
    const countB2 = students.filter(s => String(s.final_level || '').includes('اللبنة 2')).length;
    const countB1 = students.filter(s => String(s.final_level || '').includes('اللبنة 1')).length;
    const countAbs = students.filter(s => s.status === 'absent' || s.final_level === 'غائب').length;
    const countUneval = totalStudents - countB3 - countB2 - countB1 - countAbs;

    const rowsT1 = [
        ['اللبنة 3', 'مستوى متقدم (الطلاقة والفهم في النصوص المتوسطة)', countB3, `${((countB3 / totalStudents) * 100).toFixed(1)}%`, 'تحكم تام'],
        ['اللبنة 2', 'مستوى متوسط (الطلاقة والفهم في نصوص الفقرة)', countB2, `${((countB2 / totalStudents) * 100).toFixed(1)}%`, 'تحكم جزئي'],
        ['اللبنة 1', 'مستوى أولي (الطلاقة والفهم في النصوص القصيرة)', countB1, `${((countB1 / totalStudents) * 100).toFixed(1)}%`, 'بحاجة لدعم'],
        ['غير مقيم', 'تلاميذ قيد التقييم أو تعذر تقويمهم', countUneval > 0 ? countUneval : 0, `${(((countUneval > 0 ? countUneval : 0) / totalStudents) * 100).toFixed(1)}%`, '—'],
        ['غائب', 'تلاميذ مسجلون في حالة غياب', countAbs, `${((countAbs / totalStudents) * 100).toFixed(1)}%`, 'غياب مبرر/غير مبرر']
    ];

    rowsT1.forEach((rData, rIdx) => {
        const row = ws2.getRow(7 + rIdx);
        row.height = 20;
        rData.forEach((v, cIdx) => {
            const cell = row.getCell(cIdx + 1);
            cell.value = v;
            cell.font = fontText;
            cell.alignment = cIdx === 1 ? alignRight : alignCenter;
            cell.border = borderThin;
            if (rIdx === 0) cell.fill = fillBlock3;
            else if (rIdx === 1) cell.fill = fillBlock2;
            else if (rIdx === 2) cell.fill = fillBlock1;
            else if (rIdx === 4) cell.fill = fillAbsent;
            else if (rIdx % 2 === 1) cell.fill = fillZebra;
        });
    });

    // Total Row Table 1
    const rowTotT1 = ws2.getRow(12);
    rowTotT1.height = 22;
    ws2.mergeCells('A12:B12');
    const totCell1 = ws2.getCell('A12');
    totCell1.value = 'المجموع الكلي للتلاميذ';
    totCell1.font = fontBold;
    totCell1.alignment = alignCenter;
    totCell1.fill = fillMeta;
    totCell1.border = borderThin;

    const totCountCell = ws2.getCell('C12');
    totCountCell.value = totalStudents;
    totCountCell.font = fontBold;
    totCountCell.alignment = alignCenter;
    totCountCell.fill = fillMeta;
    totCountCell.border = borderThin;

    const totPctCell = ws2.getCell('D12');
    totPctCell.value = '100.0%';
    totPctCell.font = fontBold;
    totPctCell.alignment = alignCenter;
    totPctCell.fill = fillMeta;
    totPctCell.border = borderThin;

    const totNoteCell = ws2.getCell('E12');
    totNoteCell.value = '—';
    totNoteCell.font = fontBold;
    totNoteCell.alignment = alignCenter;
    totNoteCell.fill = fillMeta;
    totNoteCell.border = borderThin;

    // Table 2: Detailed Stages Analysis
    const startT2 = 14;
    ws2.mergeCells(`A${startT2}:E${startT2}`);
    const t2Header = ws2.getCell(`A${startT2}`);
    t2Header.value = 'ثانياً: التحليل الإحصائي الدقيق حسب المحطات الست (Stages)';
    t2Header.font = fontTitleMd;
    t2Header.alignment = alignRight;
    ws2.getRow(startT2).height = 20;

    const headersT2 = ['رمز المحطة', 'تسمية المحطة البيداغوجية', 'المجتازون', 'المتمكنون (1)', 'نسبة التمكن (%)'];
    const rowH2 = ws2.getRow(startT2 + 1);
    rowH2.height = 24;
    headersT2.forEach((h, idx) => {
        const cell = rowH2.getCell(idx + 1);
        cell.value = h;
        cell.font = fontHeader;
        cell.fill = fillHeader;
        cell.alignment = alignCenter;
        cell.border = borderHeader;
    });

    const stagesMeta = [
        ['LTC', 'الطلاقة على مستوى النص القصير'],
        ['CTC', 'الفهم على مستوى النص القصير'],
        ['LP', 'الطلاقة على مستوى الفقرة'],
        ['CP', 'الفهم على مستوى الفقرة'],
        ['LTM', 'الطلاقة على مستوى النص المتوسط'],
        ['CTM', 'الفهم على مستوى النص المتوسط']
    ];

    stagesMeta.forEach(([sKey, sLabel], sIdx) => {
        const rowIdx = startT2 + 2 + sIdx;
        const row = ws2.getRow(rowIdx);
        row.height = 20;

        const attempted = students.filter(s => s.stages && s.stages[sKey] !== undefined && s.stages[sKey] !== 'N/A').length;
        const passed = students.filter(s => s.stages && (s.stages[sKey] === 1 || s.stages[sKey] === '1' || s.stages[sKey] === 'متحكم')).length;
        const pct = attempted > 0 ? `${((passed / attempted) * 100).toFixed(1)}%` : '0.0%';

        const vals = [sKey, sLabel, attempted, passed, pct];
        vals.forEach((v, cIdx) => {
            const cell = row.getCell(cIdx + 1);
            cell.value = v;
            cell.font = fontText;
            cell.alignment = cIdx === 1 ? alignRight : alignCenter;
            cell.border = borderThin;
            if (sIdx % 2 === 1) cell.fill = fillZebra;
        });
    });

    // Signature Rows
    const sigRow = startT2 + 9;
    ws2.getRow(sigRow).height = 28;
    ws2.mergeCells(`A${sigRow}:B${sigRow}`);
    const sig1 = ws2.getCell(`A${sigRow}`);
    sig1.value = 'توقيع وتأشيرة أستاذ(ة) المادة:';
    sig1.font = fontBold;
    sig1.alignment = alignRight;

    ws2.mergeCells(`D${sigRow}:E${sigRow}`);
    const sig2 = ws2.getCell(`D${sigRow}`);
    sig2.value = 'تأشيرة ومصادقة الإدارة التربوية:';
    sig2.font = fontBold;
    sig2.alignment = alignCenter;

    // Trigger Download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `نتائج_تقويم_القراءة_${metadata.className || 'رائدة'}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
};

// Dynamic API Base URL & User Identification
window.API_BASE = (window.location.protocol === 'file:' || window.location.port === '5500' || window.location.port === '3000') 
    ? 'http://127.0.0.1:5000' 
    : '';

window.getAuthHeaders = (additionalHeaders = {}) => {
    const currentUserId = localStorage.getItem('ra2ida_user_uid') || 'default_user';
    return {
        'X-User-Id': currentUserId,
        ...additionalHeaders
    };
};

// ============================================================================
// 4. Cloud Backup & Sync Service (Firebase / Firestore)
// ============================================================================

// Toast Notification Helper
window.showToast = function(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'fixed bottom-6 left-6 z-[99999] flex flex-col gap-2 pointer-events-none';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl backdrop-blur-xl border text-sm font-cairo font-bold transition-all duration-300 transform translate-y-4 opacity-0 ${
        type === 'success' 
            ? 'bg-emerald-500/90 text-white border-emerald-400 shadow-emerald-500/20' 
            : type === 'error' 
                ? 'bg-rose-500/90 text-white border-rose-400 shadow-rose-500/20' 
                : 'bg-slate-900/90 text-white border-white/20 shadow-black/20'
    }`;
    
    let iconSvg = '';
    if (type === 'success') {
        iconSvg = `<svg class="w-5 h-5 shrink-0 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>`;
    } else if (type === 'error') {
        iconSvg = `<svg class="w-5 h-5 shrink-0 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="2"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else {
        iconSvg = `<svg class="w-5 h-5 shrink-0 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="2"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    }

    toast.innerHTML = `${iconSvg}<span>${window.escapeHTML(message)}</span>`;
    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.remove('translate-y-4', 'opacity-0');
        toast.classList.add('translate-y-0', 'opacity-100');
    });

    setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-4', 'opacity-0');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
    }, 4000);
};




// ============================================================================
// 5. Cloud Backup & Restore Handlers (Secured against Orphan Records)
// ============================================================================
window.CloudSync = {
    getUid() {
        return localStorage.getItem('ra2ida_user_uid') || getLocalDeviceUid();
    },

    isOnline() {
        return navigator.onLine;
    },

    updateSyncUI() {
        const syncBadge = document.getElementById('cloud-sync-last-time');
        const lastSync = localStorage.getItem('ra2ida_last_cloud_sync');
        if (syncBadge) {
            syncBadge.textContent = lastSync ? `آخر مزامنة: ${lastSync}` : 'لم تتم المزامنة بعد';
        }
    }
};

window.handleCloudBackup = async function() {
    if (!cloudDb) {
        if (typeof window.showCustomAlert === 'function') {
            await window.showCustomAlert('تنبيه السحابة', 'خدمة Firebase غير متصلة.');
        }
        return;
    }

    const btn = document.getElementById('btn-cloud-backup');
    const originalContent = btn ? btn.innerHTML : '';

    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `
                <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg> جاري الرفع...
            `;
        }

        const uid = await window.ensureCloudAuthReady();
        if (uid.startsWith('device_') && !navigator.onLine) {
            throw new Error('تعذر التحقق من الاتصال بالإنترنت.');
        }

        const classes = await localAppDb.classes.where('user_id').equals(uid).toArray();
        const students = await localAppDb.students.where('user_id').equals(uid).toArray();
        
        const backupData = {
            userId: uid,
            updatedAt: (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue)
                ? firebase.firestore.FieldValue.serverTimestamp()
                : new Date(),
            classes: classes,
            students: students,
            settings: localStorage.getItem('ra2ida_app_settings') || '{}'
        };

        await cloudDb.collection('user_backups').doc(uid).set(backupData);
        
        const timeStr = new Date().toLocaleTimeString('ar-MA', { hour: '2-digit', minute: '2-digit' });
        localStorage.setItem('ra2ida_last_cloud_sync', timeStr);
        if (window.CloudSync) window.CloudSync.updateSyncUI();
        
        if (typeof window.showToast === 'function') {
            window.showToast('تم حفظ النسخة السحابية بنجاح.', 'success');
        }
    } catch (error) {
        console.error('Cloud backup error:', error);
        if (typeof window.showCustomAlert === 'function') {
            await window.showCustomAlert('فشل الحفظ السحابي', error.message || 'حدث خطأ أثناء رفع البيانات.');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
    }
};

window.handleCloudRestore = async function() {
    if (!cloudDb) return;

    const confirmRestore = await window.showCustomConfirm(
        'تأكيد الاستعادة السحابية',
        'تنبيه: سيؤدي استرجاع النسخة السحابية إلى استبدال البيانات المحلية الحالية بآخر نسخة محفوظة على السحابة. هل ترغب في المتابعة؟',
        'استرجاع النسخة السحابية',
        'إلغاء'
    );
    if (!confirmRestore) return;

    const btn = document.getElementById('btn-cloud-restore');
    const originalContent = btn ? btn.innerHTML : '';

    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `
                <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-slate-500 inline" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg> جاري الاسترجاع...
            `;
        }

        const uid = await window.ensureCloudAuthReady();
        const docRef = await cloudDb.collection('user_backups').doc(uid).get();
        
        if (!docRef.exists) {
            if (typeof window.showCustomAlert === 'function') {
                await window.showCustomAlert('استرجاع البيانات', 'لا توجد نسخة سحابية محفوظة مسبقاً لهذا الحساب.');
            }
            return;
        }

        const data = docRef.data();
        
        // Clean and restore local DB
        const userClasses = await localAppDb.classes.where('user_id').equals(uid).toArray();
        const classIds = userClasses.map(c => c.id);
        await localAppDb.students.where('class_id').anyOf(classIds).delete();
        await localAppDb.classes.where('user_id').equals(uid).delete();

        if (data.classes && data.classes.length > 0) {
            await localAppDb.classes.bulkAdd(data.classes);
        }
        if (data.students && data.students.length > 0) {
            await localAppDb.students.bulkAdd(data.students);
        }
        if (data.settings) {
            localStorage.setItem('ra2ida_app_settings', data.settings);
        }

        // Refresh application views
        if (typeof window.fetchAndRenderClasses === 'function') await window.fetchAndRenderClasses();
        if (typeof window.renderWelcomeLaunchpad === 'function') await window.renderWelcomeLaunchpad();
        if (typeof window.initQuickClassSelector === 'function') await window.initQuickClassSelector();
        if (typeof window.renderClassesGrid === 'function') window.renderClassesGrid();
        if (typeof window.updateDashboardStats === 'function') window.updateDashboardStats();

        if (typeof window.showToast === 'function') {
            window.showToast('تم استرجاع النسخة السحابية بنجاح.', 'success');
        }
    } catch (error) {
        console.error('Cloud restore error:', error);
        if (typeof window.showCustomAlert === 'function') {
            await window.showCustomAlert('فشل الاسترجاع', error.message || 'تعذر استرداد البيانات.');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    if (window.CloudSync) window.CloudSync.updateSyncUI();
    window.playSnappyEntrance = (selector, yOffset = 15) => {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0 && typeof gsap !== 'undefined') {
            // Ensure elements are visible before animating
            gsap.set(elements, { opacity: 0, y: yOffset });
            gsap.to(elements, { 
                opacity: 1, y: 0, duration: 0.4, stagger: 0.03, ease: 'power2.out', clearProps: 'all' 
            });
        }
    };
// ============================================================================
// 1. Universal Custom Modals (FIFO Queue Architecture)
// ============================================================================
window.modalQueue = [];
window.isModalActive = false;

function processNextModalQueue() {
    if (window.modalQueue.length === 0) {
        window.isModalActive = false;
        return;
    }
    window.isModalActive = true;
    const nextModal = window.modalQueue.shift();
    if (typeof nextModal === 'function') {
        nextModal();
    }
}
window.processNextModal = processNextModalQueue;
window.runNextModal = processNextModalQueue;

window.showCustomAlert = function(title, message) {
    return new Promise((resolve) => {
        window.modalQueue.push(() => {
            const modal = document.getElementById('custom-alert-modal');
            const titleEl = document.getElementById('custom-alert-title');
            const msgEl = document.getElementById('custom-alert-message');
            const okBtn = document.getElementById('btn-alert-ok');

            const displayTitle = message ? title : 'تنبيه';
            const displayMsg = message || title || '';

            if (!modal || !okBtn) {
                alert(message ? `${displayTitle}\n${displayMsg}` : displayTitle);
                resolve();
                processNextModalQueue();
                return;
            }

            if (titleEl) titleEl.textContent = displayTitle;
            if (msgEl) msgEl.textContent = displayMsg;
            modal.classList.remove('hidden');

            const handleOk = () => {
                modal.classList.add('hidden');
                okBtn.removeEventListener('click', handleOk);
                window.removeEventListener('keydown', handleKey);
                modal.removeEventListener('click', handleBackdrop);
                if (document.activeElement) document.activeElement.blur();
                resolve();
                processNextModalQueue();
            };

            const handleKey = (e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                    e.preventDefault();
                    handleOk();
                }
            };

            const handleBackdrop = (e) => {
                if (e.target === modal) handleOk();
            };

            okBtn.addEventListener('click', handleOk, { once: true });
            window.addEventListener('keydown', handleKey);
            modal.addEventListener('click', handleBackdrop);
            okBtn.focus();
        });

        if (!window.isModalActive) {
            processNextModalQueue();
        }
    });
};

window.showCustomConfirm = function(title, message, confirmText = 'نعم', cancelText = 'إلغاء') {
    return new Promise((resolve) => {
        window.modalQueue.push(() => {
            const modal = document.getElementById('custom-confirm-modal');
            const titleEl = document.getElementById('custom-confirm-title');
            const msgEl = document.getElementById('custom-confirm-message');
            const confirmBtn = document.getElementById('btn-confirm-action');
            const cancelBtn = document.getElementById('btn-confirm-cancel');

            const displayTitle = message ? title : 'تأكيد الإجراء';
            const displayMsg = message || title || '';

            if (!modal || !confirmBtn || !cancelBtn) {
                const fallback = confirm(message ? `${displayTitle}\n${displayMsg}` : displayTitle);
                resolve(fallback);
                processNextModalQueue();
                return;
            }

            if (titleEl) titleEl.textContent = displayTitle;
            if (msgEl) msgEl.textContent = displayMsg;
            if (confirmBtn) confirmBtn.textContent = confirmText;
            if (cancelBtn) cancelBtn.textContent = cancelText;
            modal.classList.remove('hidden');

            const cleanup = (result) => {
                modal.classList.add('hidden');
                confirmBtn.removeEventListener('click', onConfirm);
                cancelBtn.removeEventListener('click', onCancel);
                window.removeEventListener('keydown', handleKey);
                modal.removeEventListener('click', handleBackdrop);
                if (document.activeElement) document.activeElement.blur();
                resolve(result);
                processNextModalQueue();
            };

            const onConfirm = () => cleanup(true);
            const onCancel = () => cleanup(false);

            const handleKey = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    cleanup(true);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cleanup(false);
                }
            };

            const handleBackdrop = (e) => {
                if (e.target === modal) cleanup(false);
            };

            confirmBtn.addEventListener('click', onConfirm, { once: true });
            cancelBtn.addEventListener('click', onCancel, { once: true });
            window.addEventListener('keydown', handleKey);
            modal.addEventListener('click', handleBackdrop);
            confirmBtn.focus();
        });

        if (!window.isModalActive) {
            processNextModalQueue();
        }
    });
};
    // Shared State
    let students = []; // Actively loaded from the server
    window.currentActiveStudents = students;
    window.State = window.State || {
        get students() { return students; },
        set students(val) { students = val; window.currentActiveStudents = val; },
        get currentStudent() { return currentFsm ? currentFsm.student : null; }
    };
    let currentFsm = null;
    let timerInterval = null;
    let TOTAL_TIME = 60;
    let timeLeft = TOTAL_TIME;
    let isTimerRunning = false;
    let selectedFile = null;

    window.MOROCCAN_REGIONS_DATA = {
        "جهة طنجة - تطوان - الحسيمة": ["طنجة-أصيلة", "تطوان", "المضيق-الفنيدق", "الفحص-أنجرة", "العرائش", "شفشاون", "وزان", "الحسيمة"],
        "جهة الشرق": ["وجدة-أنكاد", "بركان", "الناظور", "الدريوش", "تاوريرت", "جرسيف", "جرادة", "فجيج"],
        "جهة فاس - مكناس": ["فاس", "مكناس", "صفرو", "إفران", "الحاجب", "تاونات", "تازة", "بولمان", "مولاي يعقوب"],
        "جهة الرباط - سلا - القنيطرة": ["الرباط", "سلا", "الصخيرات-تمارة", "القنيطرة", "الخميسات", "سيدي قاسم", "سيدي سليمان"],
        "جهة بني ملال - خنيفرة": ["بني ملال", "أزيلال", "الفقيه بن صالح", "خنيفرة", "خريبكة"],
        "جهة الدار البيضاء - سطات": ["الدار البيضاء (أنفا)", "الفداء-مرس السلطان", "عين السبع-الحي المحمدي", "الحي الحسني", "عين الشق", "سيدي البرنوصي", "ابن مسيك", "مولاي رشيد", "المحمدية", "النواصر", "مديونة", "سطات", "برشيد", "بنسليمان", "الجديدة", "سيدي بنور"],
        "جهة مراكش - آسفي": ["مراكش", "الحوز", "شيشاوة", "قلعة السراغنة", "الصويرة", "الرحامنة", "آسفي", "اليوسفية"],
        "جهة درعة - تافيلالت": ["الرشيدية", "ورزازات", "ميدلت", "تنغير", "زاكورة"],
        "جهة سوس - ماسة": ["أكادير إداوتنان", "إنزكان آيت ملول", "اشتوكة آيت باها", "تارودانت", "تيزنيت", "طاطا"],
        "جهة كلميم - واد نون": ["كلميم", "سيدي إفني", "طانطان", "آسا الزاك"],
        "جهة العيون - الساقية الحمراء": ["العيون", "بوجدور", "طرفاية", "السمارة"],
        "جهة الداخلة - وادي الذهب": ["وادي الذهب", "أوسرد"]
    };

    // Settings
    window.AppSettings = {
        keyPass: '1',
        keyFail: '0',
        keyTimer: ' ',
        keyUndo: 'z',
        darkMode: false,
        block1Name: 'اللبنة 1',
        block2Name: 'اللبنة 2',
        block3Name: 'اللبنة 3',
        timerDuration: 60,
        audioAlert: true,
        confetti: true,
        teacherName: '',
        subject: 'اللغة العربية',
        region: '',
        directorate: '',
        schoolName: ''
    };

    window.populateRegionDropdown = () => {
        const regionSelect = document.getElementById('setting-region');
        if (!regionSelect) return;
        
        let html = '<option value="" class="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 py-1.5">-- اختر الأكاديمية الجهوية --</option>';
        for (const reg of Object.keys(window.MOROCCAN_REGIONS_DATA)) {
            html += `<option value="${reg}" class="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 py-1.5">${reg}</option>`;
        }
        regionSelect.innerHTML = html;
    };

    window.handleRegionChange = (selectedDirectorate = '') => {
        const regionSelect = document.getElementById('setting-region');
        const dirSelect = document.getElementById('setting-directorate');
        if (!regionSelect || !dirSelect) return;

        const selectedRegion = regionSelect.value;
        if (!selectedRegion || !window.MOROCCAN_REGIONS_DATA[selectedRegion]) {
            dirSelect.innerHTML = '<option value="" class="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 py-1.5">-- اختر المديرية الإقليمية --</option>';
            return;
        }

        const dirs = window.MOROCCAN_REGIONS_DATA[selectedRegion];
        let html = '<option value="" class="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 py-1.5">-- اختر المديرية الإقليمية --</option>';
        dirs.forEach(d => {
            html += `<option value="${d}" ${d === selectedDirectorate ? 'selected' : ''} class="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 py-1.5">${d}</option>`;
        });
        dirSelect.innerHTML = html;
    };

    window.switchSettingsTab = function(tabKey) {
        const tabs = ['profile', 'controls', 'appearance'];
        
        tabs.forEach(key => {
            const contentEl = document.getElementById(`settings-tab-${key}`);
            const btnEl = document.getElementById(`tab-btn-${key}`);
            
            if (key === tabKey) {
                contentEl?.classList.remove('hidden');
                contentEl?.classList.add('block');
                
                if (btnEl) {
                    btnEl.className = 'settings-tab-btn px-5 py-2.5 rounded-xl font-cairo font-bold text-xs sm:text-sm transition-all duration-200 flex items-center gap-2 bg-white text-indigo-600 shadow-sm border border-slate-200/60 dark:bg-indigo-600 dark:text-white dark:border-indigo-500/30 dark:shadow-[0_0_15px_rgba(99,102,241,0.3)] cursor-pointer';
                }
            } else {
                contentEl?.classList.add('hidden');
                contentEl?.classList.remove('block');
                
                if (btnEl) {
                    btnEl.className = 'settings-tab-btn px-5 py-2.5 rounded-xl font-cairo font-bold text-xs sm:text-sm transition-all duration-200 flex items-center gap-2 text-slate-600 hover:text-slate-900 hover:bg-white/60 dark:text-slate-300 dark:hover:text-white dark:hover:bg-white/10 border border-transparent cursor-pointer';
                }
            }
        });
    };

    window.toggleDarkMode = () => {
        window.AppSettings.darkMode = !window.AppSettings.darkMode;
        localStorage.setItem('ra2ida_settings', JSON.stringify(window.AppSettings));
        applyTheme();
    };

    function applyTheme() {
        const isDark = window.AppSettings.darkMode;
        const sun = document.getElementById('theme-icon-sun');
        const moon = document.getElementById('theme-icon-moon');
        const text = document.getElementById('theme-toggle-text');
        
        if (isDark) {
            document.documentElement.classList.add('dark');
            if(sun) sun.classList.remove('hidden');
            if(moon) moon.classList.add('hidden');
            if(text) text.innerText = 'الوضع الفاتح';
            
            if (typeof Chart !== 'undefined' && Chart.defaults) {
                Chart.defaults.color = '#94a3b8';
                Chart.defaults.scale.grid.color = 'rgba(255, 255, 255, 0.05)';
            }
        } else {
            document.documentElement.classList.remove('dark');
            if(sun) sun.classList.add('hidden');
            if(moon) moon.classList.remove('hidden');
            if(text) text.innerText = 'الوضع الليلي';
            
            if (typeof Chart !== 'undefined' && Chart.defaults) {
                Chart.defaults.color = '#475569';
                Chart.defaults.scale.grid.color = '#f1f5f9';
            }
        }
        
        if (typeof dashCompareChart !== 'undefined' && dashCompareChart) dashCompareChart.update();
        if (typeof chartDoughnutInstance !== 'undefined' && chartDoughnutInstance) {
            if (chartDoughnutInstance.data && chartDoughnutInstance.data.datasets && chartDoughnutInstance.data.datasets[0] && chartDoughnutInstance.data.datasets[0].backgroundColor[4]) {
                chartDoughnutInstance.data.datasets[0].backgroundColor[4] = isDark ? '#334155' : '#e2e8f0';
            }
            chartDoughnutInstance.update();
        }
        if (typeof chartBarInstance !== 'undefined' && chartBarInstance) chartBarInstance.update();

        // ── Fix donut center text immediately (no async wait needed) ──────────
        // highlightAD / resetAD set inline style.color that overrides Tailwind dark: classes.
        // Kill any pending GSAP tweens and force the correct color + full opacity right away.
        const donutCenterVal   = document.getElementById('ad-center-val');
        const donutCenterLabel = document.getElementById('ad-center-label');
        if (donutCenterVal) {
            if (typeof gsap !== 'undefined') gsap.killTweensOf(donutCenterVal);
            donutCenterVal.style.opacity   = '1';
            donutCenterVal.style.transform = '';
            donutCenterVal.style.color     = isDark ? '#FFFFFF' : '#1E293B';
        }
        if (donutCenterLabel) {
            if (typeof gsap !== 'undefined') gsap.killTweensOf(donutCenterLabel);
            donutCenterLabel.style.opacity   = '1';
            donutCenterLabel.style.transform = '';
            // label uses Tailwind classes (text-slate-500 / dark:text-slate-400), clear any inline color
            donutCenterLabel.style.color     = '';
        }

        // ── Re-render HTML bar charts with correct theme colors / glow ────────
        // Small delay lets the CSS dark class fully propagate before isDark is
        // re-read inside initDashboard / initAnalyticsDashboard.
        setTimeout(() => {
            // Dashboard comparison chart
            if (typeof window.initDashboard === 'function') {
                const dashScreen = document.getElementById('dashboard-home');
                if (dashScreen && !dashScreen.classList.contains('hidden')) {
                    window.initDashboard();
                }
            }

            // Analytics stage-bottleneck bar chart
            if (typeof window.initAnalyticsDashboard === 'function') {
                const analyticsScreen = document.getElementById('analytics-screen');
                if (analyticsScreen && !analyticsScreen.classList.contains('hidden')) {
                    window.initAnalyticsDashboard();
                }
            }
        }, 50);
    }


    window.loadSettings = () => {
        const saved = localStorage.getItem('ra2ida_settings');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                window.AppSettings = { ...window.AppSettings, ...parsed };
            } catch (e) {
                console.error('Failed to load settings', e);
            }
        }
        
        // Populate UI
        const el = (id) => document.getElementById(id);
        if (el('setting-key-pass')) { el('setting-key-pass').value = window.AppSettings.keyPass === ' ' ? 'Space' : window.AppSettings.keyPass; el('setting-key-pass').dataset.key = window.AppSettings.keyPass; }
        if (el('setting-key-fail')) { el('setting-key-fail').value = window.AppSettings.keyFail === ' ' ? 'Space' : window.AppSettings.keyFail; el('setting-key-fail').dataset.key = window.AppSettings.keyFail; }
        if (el('setting-key-timer')) { el('setting-key-timer').value = window.AppSettings.keyTimer === ' ' ? 'Space' : window.AppSettings.keyTimer; el('setting-key-timer').dataset.key = window.AppSettings.keyTimer; }
        if (el('setting-key-undo')) { el('setting-key-undo').value = window.AppSettings.keyUndo === ' ' ? 'Space' : window.AppSettings.keyUndo; el('setting-key-undo').dataset.key = window.AppSettings.keyUndo; }
        if (el('setting-dark-mode')) el('setting-dark-mode').checked = window.AppSettings.darkMode;
        if (el('setting-block1-name')) el('setting-block1-name').value = window.AppSettings.block1Name;
        if (el('setting-block2-name')) el('setting-block2-name').value = window.AppSettings.block2Name;
        if (el('setting-block3-name')) el('setting-block3-name').value = window.AppSettings.block3Name;
        if (el('setting-timer-duration')) el('setting-timer-duration').value = window.AppSettings.timerDuration;
        if (el('setting-audio-alert')) el('setting-audio-alert').checked = window.AppSettings.audioAlert;
        if (el('setting-confetti')) el('setting-confetti').checked = window.AppSettings.confetti;

        // Teacher & Institutional Settings
        window.populateRegionDropdown();
        if (el('setting-teacher-name')) el('setting-teacher-name').value = window.AppSettings.teacherName || '';
        if (el('setting-subject')) el('setting-subject').value = window.AppSettings.subject || 'اللغة العربية';
        if (el('setting-region')) {
            el('setting-region').value = window.AppSettings.region || '';
            window.handleRegionChange(window.AppSettings.directorate || '');
        }
        if (el('setting-school-name')) el('setting-school-name').value = window.AppSettings.schoolName || '';

        // Apply dark mode
        if (typeof applyTheme === 'function') applyTheme();

        // Update timer
        TOTAL_TIME = parseInt(window.AppSettings.timerDuration) || 60;
        if (!isTimerRunning && (timeLeft === 60 || timeLeft === TOTAL_TIME)) {
            timeLeft = TOTAL_TIME;
            if (DOM.timerText) DOM.timerText.innerText = timeLeft;
        }
    };

    window.saveSettings = () => {
        const el = (id) => document.getElementById(id);
        const getKey = (id, def) => {
            const element = el(id);
            if (!element) return def;
            if (element.dataset.key !== undefined) return element.dataset.key;
            let val = element.value || def;
            return val.toLowerCase() === 'space' ? ' ' : val;
        };

        const kPass = getKey('setting-key-pass', '1');
        const kFail = getKey('setting-key-fail', '0');
        const kTimer = getKey('setting-key-timer', ' ');
        const kUndo = getKey('setting-key-undo', 'z');
        
        const msg = el('settings-save-msg');

        // Validation for duplicates
        const keysArray = [kPass.toLowerCase(), kFail.toLowerCase(), kTimer.toLowerCase(), kUndo.toLowerCase()];
        const uniqueKeys = new Set(keysArray);
        if (keysArray.length !== uniqueKeys.size) {
        if (typeof window.showToast === 'function') window.showToast('خطأ: يرجى التأكد من عدم تكرار نفس الزر لأكثر من إجراء', 'error');
            return; // Abort save
        }

        window.AppSettings = {
            keyPass: kPass,
            keyFail: kFail,
            keyTimer: kTimer,
            keyUndo: kUndo,
            darkMode: el('setting-dark-mode').checked,
            block1Name: el('setting-block1-name').value || 'اللبنة 1',
            block2Name: el('setting-block2-name').value || 'اللبنة 2',
            block3Name: el('setting-block3-name').value || 'اللبنة 3',
            timerDuration: parseInt(el('setting-timer-duration').value) || 60,
            audioAlert: el('setting-audio-alert').checked,
            confetti: el('setting-confetti') ? el('setting-confetti').checked : true,
            teacherName: el('setting-teacher-name')?.value.trim() || '',
            subject: el('setting-subject')?.value || 'اللغة العربية',
            region: el('setting-region')?.value || '',
            directorate: el('setting-directorate')?.value || '',
            schoolName: el('setting-school-name')?.value.trim() || ''
        };
        
        localStorage.setItem('ra2ida_settings', JSON.stringify(window.AppSettings));
        
        // Re-apply immediately
        window.loadSettings();

        // Show confirmation message
        if (typeof window.showToast === 'function') {
            window.showToast('تم حفظ الإعدادات بنجاح', 'success');
        }
    };

    // Key Catcher for Settings Inputs
    const settingInputs = ['setting-key-pass', 'setting-key-fail', 'setting-key-timer', 'setting-key-undo'];
    settingInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('focus', () => {
                el.dataset.oldValue = el.value;
                el.value = 'اضغط أي زر الآن...';
                el.classList.add('ring-2', 'ring-indigo-500', 'animate-pulse');
            });
            
            el.addEventListener('blur', () => {
                if (el.value === 'اضغط أي زر الآن...') {
                    el.value = el.dataset.oldValue || '';
                }
                el.classList.remove('ring-2', 'ring-indigo-500', 'animate-pulse');
            });

            el.addEventListener('keydown', (e) => {
                if (e.key === 'Tab' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
                
                e.preventDefault();
                el.classList.remove('ring-2', 'ring-indigo-500', 'animate-pulse');
                
                let displayVal = e.key;
                if (e.key === ' ') {
                    displayVal = 'Space';
                } else if (e.key.length === 1) {
                    displayVal = e.key.toUpperCase();
                }
                
                el.value = displayVal;
                el.dataset.key = e.key;
                
                // As requested, explicitly save if space is pressed
                if (e.key === ' ') {
                    // Update the global settings and local storage
                    let prop = 'keyPass';
                    if (id === 'setting-key-fail') prop = 'keyFail';
                    else if (id === 'setting-key-timer') prop = 'keyTimer';
                    else if (id === 'setting-key-undo') prop = 'keyUndo';
                    
                    window.AppSettings[prop] = ' ';
                    localStorage.setItem('ra2ida_settings', JSON.stringify(window.AppSettings));
                }
            });
        }
    });


    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) themeBtn.addEventListener('click', window.toggleDarkMode);

    // Call load initially
    setTimeout(window.loadSettings, 100);

    // DOM Elements
    const DOM = {
        // Screens
        uploadScreen: document.getElementById('upload-screen'),
        dashboardScreen: document.getElementById('dashboard-screen'),
        
        // Upload Elements
        dropZone: document.getElementById('drop-zone'),
        fileInput: document.getElementById('file-input'),
        btnUpload: document.getElementById('btn-upload'),
        uploadStatus: document.getElementById('upload-status'),
        fallbackUi: document.getElementById('fallback-ui'),
        btnDownloadTemplate: document.getElementById('btn-download-template'),
        
        // Dashboard Elements
        studentListContainer: document.getElementById('student-list-container'),
        btnExport: document.getElementById('btn-export'),
        
        welcomeState: document.getElementById('welcome-state'),
        assessmentCard: document.getElementById('assessment-card'),
        completionCard: document.getElementById('completion-card'),
        
        currentStudentInfo: document.getElementById('current-student-info'),
        headerStudentName: document.getElementById('header-student-name'),
        
        stageBadge: document.getElementById('stage-badge'),
        stageTitle: document.getElementById('stage-title'),
        
        timerContainer: document.getElementById('timer-container'),
        timerVisual: document.getElementById('timer-visual'),
        comprehensionVisual: document.getElementById('comprehension-visual'),
        timerText: document.getElementById('timer-text'),
        timerPath: document.getElementById('timer-path'),
        btnStartTimer: document.getElementById('btn-start-timer'),
        badgeQuestions: document.getElementById('badge-questions'),
        
        evaluationButtons: document.getElementById('evaluation-buttons'),
        btnPass: document.getElementById('btn-pass'),
        btnFail: document.getElementById('btn-fail'),
        btnUndo: document.getElementById('btn-undo'),
        btnNextStudent: document.getElementById('btn-next-student'),
        btnResetApp: document.getElementById('btn-reset-app'),
        
        finalLevelDisplay: document.getElementById('final-level-display')
    };

    // ==========================================
    // AUDIO & AUTO-SAVE UTILS
    // ==========================================

    let audioCtx = null;

    function playTimerEndBeep() {
        if (!window.AppSettings.audioAlert) return;
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(600, audioCtx.currentTime); // Soft 600Hz
        
        gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime); // Start at 50% volume
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5); // 0.5s fade out
        
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.5);
    }

    window.playInteractionSound = (type) => {
        if (!window.AppSettings.audioAlert) return;
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            
            if (type === 'success') {
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(800, audioCtx.currentTime);
                gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
            } else if (type === 'undo') {
                oscillator.type = 'triangle';
                oscillator.frequency.setValueAtTime(300, audioCtx.currentTime);
                gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
            }
            
            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            oscillator.start();
            oscillator.stop(audioCtx.currentTime + 0.15);
        } catch(e) { console.warn('Audio play failed', e); }
    };

    window.triggerProfessionalConfetti = () => {
        if (!window.AppSettings.confetti || typeof confetti === 'undefined') return;
        confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 }, colors: ['#fbbf24', '#cbd5e1', '#6366f1'] });
    };

    function saveState() {
        if (students && students.length > 0) {
            localStorage.setItem('assessment_backup', JSON.stringify(students));
            checkCompletion(); // Check if this save triggers the completion dashboard
        }
    }

    // ==========================================
    // ANALYTICS DASHBOARD
    // ==========================================
    let resultsChartInstance = null;

window.checkCompletion = function checkCompletion() {
    if (!students || students.length === 0) return;
    const isComplete = students.every(s => s.status !== 'pending');
    if (isComplete) {
        if (typeof resetAndCleanupDOM === 'function') {
            resetAndCleanupDOM(() => {
                const completionScreen = document.getElementById('completion-screen');
                if (completionScreen) {
                    completionScreen.classList.remove('hidden');
                    completionScreen.classList.add('flex');
                    completionScreen.style.display = 'flex';
                    if (typeof gsap !== 'undefined') {
                        gsap.fromTo(completionScreen, {opacity: 0, y: 20}, {opacity: 1, y: 0, duration: 0.5, ease: 'power2.out'});
                    }
                }
            });
        } else {
            DOM.welcomeState.classList.add('hidden');
            DOM.welcomeState.style.display = 'none';
            DOM.assessmentCard.classList.add('hidden');
            DOM.assessmentCard.style.display = 'none';
            DOM.completionCard.classList.add('hidden');
            DOM.currentStudentInfo.classList.add('hidden');
            const completionScreen = document.getElementById('completion-screen');
            if (completionScreen) {
                completionScreen.classList.remove('hidden');
                completionScreen.classList.add('flex');
                completionScreen.style.display = 'flex';
                if (typeof gsap !== 'undefined') {
                    gsap.fromTo(completionScreen, {opacity: 0, y: 20}, {opacity: 1, y: 0, duration: 0.5, ease: 'power2.out'});
                }
            }
        }
    }
}

    // Bind large export button
    document.getElementById('btn-export-large').addEventListener('click', () => {
        DOM.btnExport.click(); // Reuse existing export logic
    });

    const btnReturnLaunchpad = document.getElementById('btn-return-launchpad');
    if (btnReturnLaunchpad) {
        btnReturnLaunchpad.addEventListener('click', () => {
            const DOM_btnResetApp = document.getElementById('btn-reset-app');
            if (DOM_btnResetApp) DOM_btnResetApp.click(); // Reuse existing flawless cleanup logic
            
            const classCompletionScreen = document.getElementById('completion-screen');
            if (classCompletionScreen) {
                classCompletionScreen.classList.add('hidden');
                classCompletionScreen.style.display = 'none';
            }
        });
    }

    // ==========================================
    // UPLOAD & RECOVERY LOGIC
    // ==========================================

    const DOM_recoveryAlert = document.getElementById('recovery-alert');
    const DOM_btnIgnoreRecovery = document.getElementById('btn-ignore-recovery');
    const DOM_btnResumeRecovery = document.getElementById('btn-resume-recovery');

    const backup = localStorage.getItem('assessment_backup');
    if (backup) {
        DOM_recoveryAlert.classList.remove('hidden');
    }

    DOM_btnIgnoreRecovery.addEventListener('click', () => {
        localStorage.removeItem('assessment_backup');
        DOM_recoveryAlert.classList.add('hidden');
    });

    DOM_btnResumeRecovery.addEventListener('click', () => {
        try {
            students = JSON.parse(localStorage.getItem('assessment_backup'));
            DOM.uploadScreen.classList.add('hidden');
            DOM.dashboardScreen.classList.remove('hidden');
            renderStudentList(students);
        } catch (e) {
            console.error('Failed to load backup', e);
            localStorage.removeItem('assessment_backup');
        }
    });

    DOM.dropZone.addEventListener('click', () => DOM.fileInput.click());

    DOM.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            selectedFile = e.target.files[0];
            DOM.dropZone.querySelector('p.text-indigo-600').innerText = selectedFile.name;
            DOM.btnUpload.classList.remove('opacity-50', 'pointer-events-none');
            DOM.uploadStatus.classList.add('hidden');
            if (DOM.fallbackUi) DOM.fallbackUi.classList.add('hidden');
        }
    });

    DOM.btnUpload.addEventListener('click', async () => {
        if (!selectedFile) return;

        DOM.btnUpload.innerText = 'جاري المعالجة...';
        DOM.btnUpload.classList.add('opacity-50', 'pointer-events-none');

        try {
            const parsed = await window.parseMassarWorkbook(selectedFile);
            const saveRes = await window.LocalDB.saveClassWithStudents(parsed.className, parsed.level, parsed.students);
            window.currentClassId = saveRes.classId;
            students = await window.LocalDB.getClassStudents(saveRes.classId);

            if (typeof window.initQuickClassSelector === 'function') window.initQuickClassSelector();
            if (typeof window.fetchAndRenderClasses === 'function') window.fetchAndRenderClasses();

            // Transition UI upon success
            gsap.to(DOM.uploadScreen, {
                opacity: 0,
                y: -20,
                duration: 0.5,
                onComplete: () => {
                    DOM.uploadScreen.classList.add('hidden');
                    DOM.dashboardScreen.classList.remove('hidden');
                    
                    renderStudentList(students);
                    
                    // Dashboard initial entrance animation
                    gsap.from(DOM.dashboardScreen.querySelector('aside'), { x: 50, opacity: 0, duration: 0.8, ease: "power3.out" });
                    gsap.from(DOM.welcomeState, { y: 30, opacity: 0, duration: 0.8, delay: 0.3, ease: "power3.out" });
                }
            });

        } catch (error) {
            let errorMsg = error.message || 'فشل معالجة الملف';
            DOM.uploadStatus.innerText = errorMsg;
            DOM.uploadStatus.classList.remove('hidden');
            DOM.btnUpload.innerText = 'تأكيد وبدء التقييم';
            DOM.btnUpload.classList.remove('opacity-50', 'pointer-events-none');
        }
    });

    // ==========================================
    // EXPORT LOGIC
    // ==========================================

    DOM.btnExport.addEventListener('click', async () => {
        let currentStudents = [];
        if (window.currentClassId) {
            currentStudents = await window.LocalDB.getClassStudents(window.currentClassId);
        } else if (students && students.length > 0) {
            currentStudents = students;
        }

        if (!currentStudents || currentStudents.length === 0) {
            window.showCustomAlert('لا توجد بيانات تلاميذ لتصديرها');
            return;
        }

        if (!currentStudents.some(s => s.status && s.status !== 'pending')) {
            window.showCustomAlert('الرجاء تقييم تلميذ واحد على الأقل قبل تحميل النتائج.');
            return;
        }
        
        const originalText = DOM.btnExport.innerHTML;
        DOM.btnExport.innerHTML = 'جاري التصدير...';
        DOM.btnExport.classList.add('opacity-50', 'pointer-events-none');
        
        try {
            // Retrieve current active class name and level from selector or roster
            const quickSelect = document.getElementById('quick-class-select');
            let selectedClassName = '';
            if (quickSelect && quickSelect.selectedIndex > 0) {
                selectedClassName = quickSelect.options[quickSelect.selectedIndex].text;
            }

            const metadata = {
                teacherName: window.AppSettings.teacherName || '',
                subject: window.AppSettings.subject || 'اللغة العربية',
                region: window.AppSettings.region || '',
                directorate: window.AppSettings.directorate || '',
                schoolName: window.AppSettings.schoolName || '',
                className: selectedClassName || (window.currentClassId ? `القسم ${window.currentClassId}` : 'الفوج')
            };

            await window.generateClientSideExcel(currentStudents, metadata);
            
            // Job is fully done, clear disaster recovery
            localStorage.removeItem('assessment_backup');
            
        } catch (error) {
            console.error('Export Error:', error);
            window.showCustomAlert('حدث خطأ أثناء التصدير: ' + error.message);
        } finally {
            DOM.btnExport.innerHTML = originalText;
            DOM.btnExport.classList.remove('opacity-50', 'pointer-events-none');
        }
    });

    // ==========================================
    // RENDERING & DOM CLEANUP
    // ==========================================

    function resetAndCleanupDOM(onCompleteCallback) {
        if (currentFsm) {
            currentFsm.resetState(timerInterval);
            currentFsm = null;
        } else {
            clearInterval(timerInterval);
        }
        
        isTimerRunning = false;
        if (typeof gsap !== 'undefined') {
            gsap.killTweensOf([DOM.timerText, DOM.assessmentCard, DOM.completionCard, DOM.welcomeState]);
        }
        DOM.timerText.style.color = '';

        // Strictly hide inactive workspaces by resetting both inline style and classList
        const completionScreen = document.getElementById('completion-screen');
        [DOM.completionCard, DOM.welcomeState, completionScreen, DOM.assessmentCard].forEach(el => {
            if (el) {
                el.classList.add('hidden');
                el.classList.remove('flex');
                el.style.display = 'none';
            }
        });

        if (onCompleteCallback) onCompleteCallback();
    }

    function resetApplication() {
        students = [];
        selectedFile = null;
        localStorage.removeItem('assessment_backup');
        
        DOM.fileInput.value = '';
        DOM.dropZone.querySelector('p.text-indigo-600').innerText = 'اضغط هنا لاختيار الملف';
        DOM.btnUpload.innerText = 'تأكيد وبدء التقييم';
        DOM.btnUpload.classList.add('opacity-50', 'pointer-events-none');
        DOM.uploadStatus.classList.add('hidden');
        if (DOM.fallbackUi) DOM.fallbackUi.classList.add('hidden');
        DOM.btnExport.classList.add('hidden');
        
        resetAndCleanupDOM(() => {
            DOM.studentListContainer.innerHTML = '';
            delete DOM.studentListContainer.dataset.loaded;
            
            DOM.welcomeState.classList.remove('hidden');
            gsap.set(DOM.welcomeState, { display: 'block' });
            DOM.currentStudentInfo.classList.add('hidden');
            
            gsap.to(DOM.dashboardScreen, {
                opacity: 0,
                y: 20,
                duration: 0.4,
                onComplete: () => {
                    DOM.dashboardScreen.classList.add('hidden');
                    DOM.uploadScreen.classList.remove('hidden');
                    gsap.fromTo(DOM.uploadScreen, 
                        { opacity: 0, y: -20 },
                        { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }
                    );
                }
            });
        });
    }

    window.getPlacementLevelBadgeHtml = function(levelName) {
        const lvl = String(levelName || 'اللبنة 1');
        
        if (lvl.includes('3')) {
            // Emerald / Green Soft Pill
            return `
                <span class="inline-flex items-center justify-center font-cairo font-bold text-xs px-3 py-1 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-500/30 shadow-xs">
                    ${lvl}
                </span>
            `;
        } else if (lvl.includes('2')) {
            // Amber / Yellow Soft Pill
            return `
                <span class="inline-flex items-center justify-center font-cairo font-bold text-xs px-3 py-1 rounded-xl bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-500/30 shadow-xs">
                    ${lvl}
                </span>
            `;
        } else {
            // Sky / Blue Soft Pill (Block 1)
            return `
                <span class="inline-flex items-center justify-center font-cairo font-bold text-xs px-3 py-1 rounded-xl bg-sky-50 text-sky-600 border border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-500/30 shadow-xs">
                    ${lvl}
                </span>
            `;
        }
    };

    function getStatusUI(student) {
        const isAbsent = (student.status === 'absent' || student.final_level === 'غائب');
        if (isAbsent) {
            return { class: 'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-500/30', text: 'غائب' };
        }
        if (student.status === 'pending' || !student.final_level || student.final_level === 'غير مقيم') {
            return { class: 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10', text: 'قيد الانتظار' };
        }
        
        const lvl = String(student.final_level || student.level || 'اللبنة 1');
        if (lvl.includes('3')) {
            return { class: 'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-500/30', text: window.AppSettings.block3Name || 'اللبنة 3' };
        } else if (lvl.includes('2')) {
            return { class: 'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-500/30', text: window.AppSettings.block2Name || 'اللبنة 2' };
        } else {
            return { class: 'bg-sky-50 text-sky-600 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-500/30', text: window.AppSettings.block1Name || 'اللبنة 1' };
        }
    }

    window.toggleStudentAbsence = async function(studentId, event) {
        if (event) {
            event.stopPropagation();
            event.preventDefault();
        }

        const numericId = Number(studentId);
        const targetList = (students && students.length > 0) ? students : (window.currentActiveStudents || []);
        const student = targetList.find(s => Number(s.id) === numericId || String(s.id) === String(studentId));
        if (!student) {
            console.warn('Student not found for absence toggle:', studentId);
            return;
        }

        const isCurrentlyAbsent = (student.status === 'absent' || student.final_level === 'غائب');

        if (isCurrentlyAbsent) {
            student.status = 'pending';
            student.final_level = 'غير مقيم';
            student.stages = { LTC: 'N/A', CTC: 'N/A', LP: 'N/A', CP: 'N/A', LTM: 'N/A', CTM: 'N/A' };
        } else {
            student.status = 'absent';
            student.final_level = 'غائب';
            student.stages = { LTC: 'N/A', CTC: 'N/A', LP: 'N/A', CP: 'N/A', LTM: 'N/A', CTM: 'N/A' };
        }

        // 1. Persist to LocalDB (IndexedDB)
        try {
            if (student.id) {
                await window.LocalDB.updateStudent(student.id, {
                    status: student.status,
                    final_level: student.final_level,
                    stages: student.stages
                });
            }
        } catch (err) {
            console.error('Failed to update student absence in LocalDB:', err);
        }

        // 2. Re-render the student list from source array
        if (typeof saveState === 'function') saveState();
        if (typeof renderStudentList === 'function') {
            renderStudentList(students);
        }

        // 3. If the absent student was currently active, auto-advance to the next pending student
        if (currentFsm && currentFsm.student && (Number(currentFsm.student.id) === numericId || String(currentFsm.student.id) === String(studentId))) {
            if (!isCurrentlyAbsent) {
                // Student was just marked absent — move to the next pending student automatically
                currentFsm = null; // Clear the active FSM so loadNextStudent picks the correct "current" index
                if (typeof loadNextStudent === 'function') {
                    await loadNextStudent();
                }
            }
        }
    };

    window.toggleAbsent = (e, studentId) => window.toggleStudentAbsence(studentId, e);

    function renderStudentList(studentDataArray) {
        const listToRender = (studentDataArray && studentDataArray.length > 0) ? studentDataArray : (students || window.currentActiveStudents || []);
        
        // Show export button if there are any evaluated students
        if (listToRender.some(s => s.status !== 'pending' && s.final_level !== 'غير مقيم')) {
            DOM.btnExport.classList.remove('hidden');
        } else {
            DOM.btnExport.classList.add('hidden');
        }
        
        const avatarColors = [
            'bg-blue-100 text-blue-600', 
            'bg-emerald-100 text-emerald-600', 
            'bg-purple-100 text-purple-600', 
            'bg-amber-100 text-amber-600', 
            'bg-rose-100 text-rose-600'
        ];
        
        // Force browser layout recalculation/repaint
        setTimeout(() => {
            DOM.studentListContainer.innerHTML = '';
            
            // 1. The Intersection Observer Logic
            const observer = new IntersectionObserver((entries, obs) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.classList.remove('opacity-0', 'translate-y-6');
                        entry.target.classList.add('opacity-100', 'translate-y-0');
                        obs.unobserve(entry.target); // Crucial: animate only once
                    }
                });
            }, { root: DOM.studentListContainer, threshold: 0.1 });
            
            const isInitialRender = !DOM.studentListContainer.dataset.loaded;
            
            listToRender.forEach((student, index) => {
                const btn = document.createElement('button');
                const isActive = currentFsm && currentFsm.student && (
                    (student.id && String(currentFsm.student.id) === String(student.id)) ||
                    (student.massar_id && currentFsm.student.massar_id === student.massar_id)
                );
                
                const isAbsent = (student.status === 'absent' || student.final_level === 'غائب');
                const isCompleted = (student.status === 'completed' || student.status === 'evaluated' || (student.final_level && student.final_level !== 'غير مقيم' && !isAbsent));
                
                // 2. CSS/Tailwind Initial State
                const baseClass = "w-full text-right flex items-center justify-between group cursor-pointer transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:brightness-105 relative overflow-hidden rounded-xl p-3 mb-3 after:absolute after:inset-0 after:rounded-xl after:border after:border-white/0 hover:after:border-white/40 dark:hover:after:border-white/10 after:transition-colors after:duration-300 " + (isInitialRender ? "opacity-0 translate-y-6" : "opacity-100 translate-y-0");
                
                let cardBgClasses = 'bg-white/40 border border-slate-200/60 shadow-sm backdrop-blur-md hover:bg-white/80 dark:bg-white/5 dark:border-white/10 dark:hover:bg-white/10 dark:hover:border-white/20 dark:text-slate-300';
                let leftActionsHtml = '';

                if (isActive) {
                    cardBgClasses = "bg-gradient-to-l from-indigo-50/80 to-white/90 border border-indigo-200 border-r-4 border-r-indigo-600 shadow-md backdrop-blur-xl dark:bg-gradient-to-l dark:from-indigo-500/10 dark:to-transparent dark:border-white/10 dark:border-r-indigo-400 dark:shadow-[0_0_20px_rgba(99,102,241,0.15)] dark:backdrop-blur-2xl";
                } else if (isAbsent) {
                    cardBgClasses = "bg-rose-50/70 border-rose-200/80 dark:bg-rose-950/25 dark:border-rose-500/25";
                } else if (isCompleted) {
                    cardBgClasses = "bg-emerald-50/40 border border-emerald-100 shadow-sm backdrop-blur-md hover:bg-emerald-50/80 dark:bg-emerald-500/5 dark:border-emerald-500/20 dark:hover:bg-emerald-500/10";
                }

                btn.className = `${baseClass} ${cardBgClasses}`;

                if (isAbsent) {
                    // 1. Absent State: Rose background with prominent cancel button only
                    cardBgClasses = 'bg-rose-50/70 border-rose-200/80 dark:bg-rose-950/25 dark:border-rose-500/25';
                    leftActionsHtml = `
                        <button type="button" onclick="window.toggleStudentAbsence('${student.id}', event)" 
                                class="px-3.5 py-1.5 text-xs font-cairo font-bold text-white bg-rose-600 hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-500 rounded-xl shadow-sm shadow-rose-500/30 transition-all cursor-pointer z-30 relative">
                            إلغاء الغياب
                        </button>
                    `;
                } else if (isCompleted) {
                    const lvl = student.final_level || 'اللبنة 1';
                    leftActionsHtml = window.getPlacementLevelBadgeHtml(lvl);
                } else {
                    // 3. Pending State: Absence trigger + Waiting badge
                    leftActionsHtml = `
                        <div class="flex items-center gap-2">
                            <button type="button" onclick="window.toggleStudentAbsence('${student.id}', event)" 
                                    class="text-xs font-medium text-slate-400 hover:text-rose-600 transition-colors px-1.5 py-1 cursor-pointer z-30 relative" title="تسجيل كغائب">
                                غياب
                            </button>
                            <span class="text-xs font-medium text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 px-2.5 py-1 rounded-lg">
                                قيد الانتظار
                            </span>
                        </div>
                    `;
                }
                
                // Modern Avatar: single char + pastel color
                const initials = (student.name || 'ت').trim().charAt(0);
                const avatarColorClass = avatarColors[index % avatarColors.length];
                
                const checkmarkSvg = isCompleted ? `<svg class="w-4 h-4 text-emerald-500 inline-block ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>` : '';
                
                const avatarDimming = (isCompleted || isAbsent) ? 'opacity-50 grayscale' : '';
                const textDimming = (isCompleted || isAbsent) ? 'opacity-50' : '';
                const titleColorClass = isCompleted ? 'text-slate-800 dark:text-white font-bold' : (isAbsent ? 'text-rose-600 dark:text-rose-400 font-bold' : 'text-slate-700 dark:text-white font-medium');

                btn.innerHTML = `
                    <!-- 1. Right Side: Avatar & Name -->
                    <div class="flex items-center gap-3 flex-1 min-w-0 overflow-hidden pr-1">
                        <div class="w-10 h-10 rounded-full ${avatarColorClass} border border-white shadow-sm flex items-center justify-center font-bold shrink-0 transition-all ${avatarDimming}">
                            ${initials}
                        </div>
                        <div class="flex flex-col transition-all ${textDimming} flex-1 min-w-0">
                            <span class="text-lg ${titleColorClass} leading-tight truncate block w-full text-right">${checkmarkSvg}${window.escapeHTML(student.name)}</span>
                            <span class="text-sm text-slate-400 dark:text-slate-400 mt-0.5 truncate block w-full text-right">${student.massar_id && student.massar_id !== 'غير متوفر' ? student.massar_id : 'بدون مسار'}</span>
                        </div>
                    </div>
                    
                    <!-- 2. Left Side: Actions / Badges -->
                    <div class="flex items-center gap-1.5 z-20 relative shrink-0 pl-1">
                        ${leftActionsHtml}
                    </div>
                `;

                btn.onclick = (e) => {
                    selectStudent(student);
                };
                
                DOM.studentListContainer.appendChild(btn);
                
                if (isInitialRender) {
                    observer.observe(btn);
                }
            });
            
            // Auto-scroll to the currently active student
            const activeBtn = DOM.studentListContainer.querySelector('.border-r-indigo-600');
            if (activeBtn) {
                activeBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            
            DOM.studentListContainer.dataset.loaded = "true";
            
            if (isInitialRender) {
                window.playSnappyEntrance('#student-list-container > button', 10);
            }
        }, 0);
    }

    // ============================================================================
    // Shared: launch assessment UI for a given student object
    // ============================================================================
    function startAssessmentFlow(std) {
        resetAndCleanupDOM(() => {
            currentFsm = new window.AssessmentFlow(std, { onStateChange: handleStateChange, onComplete: handleCompletion });
            DOM.assessmentCard.classList.remove('hidden');
            if (typeof gsap !== 'undefined') gsap.set(DOM.assessmentCard, { display: 'flex' });
            DOM.currentStudentInfo.classList.remove('hidden');
            DOM.headerStudentName.innerText = std.name;
            if (typeof gsap !== 'undefined') {
                gsap.to(DOM.currentStudentInfo, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" });
                gsap.fromTo(DOM.assessmentCard, { autoAlpha: 0, scale: 0.95, y: 20 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.6, ease: "power3.out" });
            }
            renderStudentList(students);
        });
    }

    // ============================================================================
    // loadNextStudent: advances to the next pending student or returns to roster
    // ============================================================================
    async function loadNextStudent() {
        if (!window.currentClassId) return;

        try {
            // Always fetch the freshest ordered list from IndexedDB
            const freshStudents = await window.LocalDB.getClassStudents(window.currentClassId);
            // Sync local array so the sidebar stays accurate
            students = freshStudents;
            window.currentActiveStudents = students;

            // Identify the current student from the active FSM or the last known student
            const activeFsm = currentFsm;
            const currentId = activeFsm ? activeFsm.student.id : null;

            const currentIndex = currentId !== null
                ? freshStudents.findIndex(s => String(s.id) === String(currentId))
                : -1;

            // Scan forward for the next student that still needs evaluation
            const nextStudent = freshStudents
                .slice(currentIndex + 1)                           // everything after the current
                .find(s => s.status === 'pending' || !s.status);   // first one still pending

            if (nextStudent) {
                // Animate the completion card out, then start the next student
                if (typeof gsap !== 'undefined') {
                    gsap.to(DOM.completionCard, {
                        autoAlpha: 0, scale: 0.95, y: -20, duration: 0.35, ease: 'power2.in',
                        onComplete: () => startAssessmentFlow(nextStudent)
                    });
                } else {
                    DOM.completionCard.classList.add('hidden');
                    startAssessmentFlow(nextStudent);
                }
            } else {
                // All students completed - Show the final Class Completion Screen
                const completionCard = document.getElementById('completion-card');
                const assessmentCard = document.getElementById('assessment-card');

                gsap.to([completionCard, assessmentCard], {
                    autoAlpha: 0, scale: 0.95, y: -20, duration: 0.35, ease: 'power2.in',
                    onComplete: () => {
                        if (completionCard) {
                            completionCard.classList.add('hidden');
                            completionCard.style.display = 'none';
                        }
                        if (assessmentCard) {
                            assessmentCard.classList.add('hidden');
                            assessmentCard.style.display = 'none';
                        }

                        const classCompletionScreen = document.getElementById('completion-screen');
                        if (classCompletionScreen) {
                            classCompletionScreen.classList.remove('hidden');
                            classCompletionScreen.style.display = 'flex';
                            gsap.fromTo(classCompletionScreen,
                                { autoAlpha: 0, scale: 0.95, y: 20 },
                                { autoAlpha: 1, scale: 1, y: 0, duration: 0.4, ease: 'back.out(1.5)' }
                            );
                        }

                        if (typeof window.triggerProfessionalConfetti === 'function') {
                            window.triggerProfessionalConfetti();
                        }
                        if (typeof window.showToast === 'function') {
                            window.showToast('تم تقييم جميع تلاميذ القسم بنجاح', 'success');
                        }
                    }
                });
            }
        } catch (err) {
            console.error('[loadNextStudent] Error fetching students:', err);
            window.showToast('حدث خطأ أثناء تحميل التلميذ التالي', 'error');
        }
    }

    window.selectStudent = async function selectStudent(student) {
        if (!student) return;
        
        const targetList = (students && students.length > 0) ? students : (window.currentActiveStudents || []);
        const matched = targetList.find(s => Number(s.id) === Number(student.id) || String(s.id) === String(student.id)) || student;

        if (matched.status === 'absent' || matched.final_level === 'غائب') {
            const confirmed = await window.showCustomConfirm(
                'إلغاء الغياب',
                `التلميذ "${matched.name}" مسجل حالياً كـ (غائب). هل تريد إلغاء الغياب وبدء التقييم الآن؟`,
                'إلغاء الغياب وبدء التقييم',
                'إلغاء'
            );
            if (confirmed) {
                await window.toggleStudentAbsence(matched.id);
                startAssessmentFlow(matched);
            }
            return;
        }

        const isAlreadyCompleted = (matched.status === 'completed' || matched.status === 'evaluated' || (matched.final_level && matched.final_level !== 'غير مقيم'));

        if (isAlreadyCompleted) {
            const confirmed = await window.showCustomConfirm(
                'إعادة تقييم التلميذ',
                `تم تقييم ${matched.name} مسبقاً (${matched.final_level || 'مقيّم'}). هل تريد مسح النتيجة وإعادة تقييمه؟`,
                'تأكيد وإعادة التقييم',
                'إلغاء'
            );
            if (confirmed) {
                matched.status = 'pending';
                matched.final_level = null;
                matched.stages = { LTC: 'N/A', CTC: 'N/A', LP: 'N/A', CP: 'N/A', LTM: 'N/A', CTM: 'N/A' };
                if (matched.id) {
                    try {
                        await window.LocalDB.updateStudent(matched.id, { 
                            status: 'pending', 
                            final_level: null,
                            stages: { LTC: 'N/A', CTC: 'N/A', LP: 'N/A', CP: 'N/A', LTM: 'N/A', CTM: 'N/A' }
                        });
                    } catch (err) { console.error('Failed to reset student', err); }
                }
                saveState();
                startAssessmentFlow(matched);
            }
            return;
        }
        startAssessmentFlow(matched);
    }

    // ==========================================
    // TIMER LOGIC
    // ==========================================

    function stopTimer() {
        clearInterval(timerInterval);
        isTimerRunning = false;
        gsap.killTweensOf(DOM.timerText);
        DOM.timerText.style.color = '';
    }

    function initTimerUI() {
        stopTimer();
        timeLeft = TOTAL_TIME;
        
        DOM.timerPath.classList.remove('pulse-red');
        gsap.killTweensOf(DOM.timerPath);
        DOM.timerPath.style.stroke = '#6366f1'; 
        DOM.timerPath.style.strokeDashoffset = '0'; 
        DOM.timerText.innerText = timeLeft;
        gsap.set(DOM.timerText, { scale: 1, color: '' });
        
        // Morph to Start state
        DOM.btnStartTimer.className = 'px-5 py-2 w-full h-full font-bold rounded-xl shadow-md transition-all text-sm flex items-center justify-center gap-1.5 border bg-indigo-600 text-white border-transparent hover:bg-indigo-700 dark:bg-indigo-600/20 dark:border-indigo-500/50 dark:text-indigo-50 dark:hover:bg-indigo-600/40 dark:shadow-[0_0_20px_rgba(99,102,241,0.4)]';
        DOM.btnStartTimer.innerHTML = '<span id="btn-timer-text">بدء العداد</span>';
        DOM.btnStartTimer.dataset.state = 'start';
    }

    function resetTimer() {
        stopTimer();
        timeLeft = TOTAL_TIME;
        
        DOM.timerPath.classList.remove('pulse-red');
        gsap.killTweensOf(DOM.timerPath);
        DOM.timerPath.style.stroke = '#6366f1'; 
        DOM.timerPath.style.strokeDashoffset = '0'; 
        DOM.timerText.innerText = timeLeft;
        gsap.set(DOM.timerText, { scale: 1, color: '' });
        
        executeTimer();
    }

    function executeTimer() {
        if (isTimerRunning) return;
        isTimerRunning = true;
        
        // Morph to Restart state (No layout shift)
        DOM.btnStartTimer.className = 'px-4 py-2 w-full h-full font-bold rounded-xl shadow-sm transition-all text-xs flex items-center justify-center gap-1.5 border bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-white/5 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10';
        DOM.btnStartTimer.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg><span id="btn-timer-text">إعادة العد</span>`;
        DOM.btnStartTimer.dataset.state = 'restart';
        
        DOM.evaluationButtons.classList.remove('invisible');
        
        gsap.fromTo(DOM.evaluationButtons, 
            { opacity: 0, y: 10 },
            { opacity: 1, y: 0, duration: 0.4 }
        );

        timerInterval = setInterval(() => {
            timeLeft--;
            DOM.timerText.innerText = timeLeft;
            
            const progress = 1 - (timeLeft / TOTAL_TIME);
            const offset = progress * 283;
            
            gsap.to(DOM.timerPath, {
                strokeDashoffset: offset,
                duration: 1,
                ease: "linear"
            });

            if (timeLeft === 30) {
                gsap.to(DOM.timerPath, { stroke: '#f59e0b', duration: 0.5 }); 
            } else if (timeLeft === 10) {
                gsap.to(DOM.timerPath, { stroke: '#ef4444', duration: 0.5 }); 
                DOM.timerPath.classList.add('pulse-red');
                gsap.to(DOM.timerText, { scale: 1.2, color: '#ef4444', yoyo: true, repeat: -1, duration: 0.5 });
            }

            if (timeLeft <= 0) {
                stopTimer();
                playTimerEndBeep();
            }
        }, 1000);
    }

    // ==========================================
    // EVENT HANDLERS
    // ==========================================

    function handleStateChange(details, student) {
        if (details.id === 'COMPLETE') return;

        const contentElements = [DOM.stageBadge, DOM.stageTitle];
        const isCardHidden = DOM.assessmentCard.classList.contains('hidden');

        const applyUIUpdates = () => {
            DOM.stageBadge.innerText = details.id.replace('_', ' ');
            DOM.stageTitle.innerText = details.name; 
            
            if (details.canUndo) {
                DOM.btnUndo.classList.remove('opacity-50', 'pointer-events-none');
                DOM.btnUndo.classList.add('hover:text-slate-800', 'cursor-pointer');
            } else {
                DOM.btnUndo.classList.add('opacity-50', 'pointer-events-none');
                DOM.btnUndo.classList.remove('hover:text-slate-800', 'cursor-pointer');
            }

            // Ensure the timer container space is always maintained
            DOM.timerContainer.classList.remove('hidden');

            if (details.requiresTimer) {
                // Show Timer Visual, Hide Comprehension Visual
                DOM.timerVisual.classList.remove('opacity-0');
                DOM.timerVisual.classList.add('opacity-100');
                DOM.comprehensionVisual.classList.remove('opacity-100');
                DOM.comprehensionVisual.classList.add('opacity-0');
                
                // Show Start Button, Hide Badge
                DOM.btnStartTimer.classList.remove('hidden');
                DOM.badgeQuestions.classList.add('hidden');
                
                DOM.evaluationButtons.classList.add('invisible');
                initTimerUI();
            } else {
                stopTimer();
                
                // Show Comprehension Visual, Hide Timer Visual
                DOM.timerVisual.classList.remove('opacity-100');
                DOM.timerVisual.classList.add('opacity-0');
                DOM.comprehensionVisual.classList.remove('opacity-0');
                DOM.comprehensionVisual.classList.add('opacity-100');
                
                // Show Badge, Hide Start Button
                DOM.btnStartTimer.classList.add('hidden');
                DOM.badgeQuestions.classList.remove('hidden');
                
                DOM.evaluationButtons.classList.remove('invisible');
            }
            
            saveState(); // Trigger Auto-save
        };

        if (isCardHidden) {
            // Instant update for new students (card is building behind the scenes)
            gsap.killTweensOf(contentElements);
            applyUIUpdates();
            gsap.set(contentElements, { y: 0, opacity: 1 });
        } else {
            // Normal animated transition between stages for the current student
            const tl = gsap.timeline();
            tl.to(contentElements, {
                y: -10, opacity: 0, duration: 0.2, stagger: 0.05, ease: "power2.in",
                onComplete: () => {
                    applyUIUpdates();
                    gsap.fromTo(contentElements, 
                        { y: 10, opacity: 0 },
                        { y: 0, opacity: 1, duration: 0.4, stagger: 0.05, ease: "back.out(1.2)" }
                    );
                }
            });
        }
    }

    function handleCompletion(level, student) {
        window.playInteractionSound('success');
        stopTimer();
        
        const studentIndex = students.findIndex(s => s.massar_id === student.massar_id);
        if (studentIndex !== -1) {
            students[studentIndex].status = "evaluated";
            students[studentIndex].final_level = level; 
            
            if (students[studentIndex].id) {
                window.LocalDB.updateStudent(students[studentIndex].id, { 
                    status: 'evaluated', 
                    final_level: level, 
                    stages: student.stages 
                }).catch(err => console.error('Failed to sync student evaluation', err));
            }
            
            renderStudentList(students);
        }

        gsap.to(DOM.assessmentCard, {
            autoAlpha: 0, scale: 0.95, y: -20, duration: 0.4, ease: "power2.in",
            onComplete: () => {
                DOM.assessmentCard.classList.add('hidden');
                gsap.set(DOM.assessmentCard, { display: 'none' });
                
                // Show completion card for EVERY student (including the last one)
                DOM.completionCard.classList.remove('hidden');
                gsap.set(DOM.completionCard, { display: 'flex' });
                
                const ui = getStatusUI({ final_level: level });
                DOM.finalLevelDisplay.className = `inline-block px-4 py-2 rounded-xl text-lg font-bold border-2 shadow-sm ${ui.class}`;
                DOM.finalLevelDisplay.innerText = ui.text;

                // Fetch fresh data from DB to accurately determine if this is the absolute last student
                (async () => {
                    try {
                        const classId = student.class_id || (typeof currentClassId !== 'undefined' ? currentClassId : null);
                        let hasMoreStudents = false;
                        
                        if (classId) {
                            const freshRoster = await window.LocalDB.getClassStudents(classId);
                            // Check if any OTHER student is still pending in the database
                            hasMoreStudents = freshRoster.some(s => (s.status === 'pending' || !s.status) && String(s.id) !== String(student.id));
                        }

                        const btnNext = document.getElementById('btn-next-student');
                        if (!hasMoreStudents) {
                            if (btnNext) {
                                btnNext.innerHTML = '<svg class="w-6 h-6 inline-block ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> إنهاء التقويم وإصدار النتائج';
                            }
                            
                            // Auto-forward after 1.5s to show the final completion dashboard seamlessly
                            setTimeout(() => {
                                if (typeof loadNextStudent === 'function') {
                                    loadNextStudent();
                                }
                            }, 1500);
                        } else {
                            if (btnNext) {
                                btnNext.innerHTML = 'تقييم تلميذ آخر';
                            }
                        }
                    } catch (err) {
                        console.error('Error checking DB for remaining students:', err);
                    }
                })();
                
                saveState(); // Trigger Auto-save
                
                gsap.fromTo(DOM.completionCard, 
                    { autoAlpha: 0, scale: 0.9, y: 30 },
                    { autoAlpha: 1, scale: 1, y: 0, duration: 0.6, ease: "back.out(1.2)" }
                );
            }
        });
    }

    DOM.btnStartTimer.addEventListener('click', () => {
        if (DOM.btnStartTimer.dataset.state === 'restart') {
            resetTimer();
        } else {
            executeTimer();
        }
    });

    DOM.btnPass.addEventListener('click', () => {
        if (!currentFsm) return;
        currentFsm.evaluate('متحكم');
    });

    DOM.btnFail.addEventListener('click', () => {
        if (!currentFsm) return;
        currentFsm.evaluate('غير متحكم');
    });

    DOM.btnUndo.addEventListener('click', () => {
        if (currentFsm) {
            window.playInteractionSound('undo');
            const icon = DOM.btnUndo.querySelector('svg');
            gsap.fromTo(icon, { rotation: 45 }, { rotation: 0, duration: 0.3, ease: "back.out(2)" });
            currentFsm.undoLastStep();
        }
    });

    DOM.btnNextStudent.addEventListener('click', (e) => {
        e.preventDefault();
        loadNextStudent();
    });

    if (DOM.btnResetApp) {
        DOM.btnResetApp.addEventListener('click', () => {
            // 0. Kill any ongoing animations to prevent them from reverting our changes
            if (typeof gsap !== 'undefined') {
                gsap.killTweensOf([DOM.assessmentCard, DOM.completionCard, DOM.currentStudentInfo, DOM.welcomeState]);
            }

            // 1. Force hide all active assessment elements (Clear GSAP + Hide)
            [DOM.assessmentCard, DOM.completionCard, DOM.currentStudentInfo].forEach(el => {
                if (el) {
                    if (typeof gsap !== 'undefined') {
                        gsap.set(el, { clearProps: "all" });
                    } else {
                        el.style.display = '';
                    }
                    el.classList.add('hidden');
                }
            });
            
            const completionScreen = document.getElementById('completion-screen');
            if (completionScreen) {
                completionScreen.classList.add('hidden');
                completionScreen.classList.remove('flex');
            }

            // 2. Force show the Launchpad (Welcome State)
            const welcomeState = document.getElementById('welcome-state');
            if (welcomeState) {
                welcomeState.classList.remove('hidden');
                if (typeof gsap !== 'undefined') {
                    gsap.set(welcomeState, { clearProps: "all" });
                    gsap.fromTo(welcomeState, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4, display: 'block' });
                } else {
                    welcomeState.style.display = 'block';
                    welcomeState.style.opacity = '1';
                }
            }

            window.toggleAssessmentSidebar(false);

    // 3. Reset Sidebar UI
            const studentListContainer = document.getElementById('student-list-container');
            if (studentListContainer) {
                studentListContainer.innerHTML = '<div id="sidebar-empty-state" class="text-center p-6 text-slate-400 font-medium text-sm flex flex-col items-center gap-3"><svg class="w-10 h-10 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>الرجاء اختيار قسم من منصة الانطلاق</div>';
            }

            const quickClassSelect = document.getElementById('quick-class-select');
            if (quickClassSelect) {
                quickClassSelect.value = '';
                quickClassSelect.classList.add('hidden');
            }
            
            DOM.btnResetApp.classList.add('hidden');

            // 4. Shutdown FSM and clear memory
            if (typeof currentFsm !== 'undefined' && currentFsm) {
                if (typeof timerInterval !== 'undefined') currentFsm.resetState(timerInterval);
                currentFsm = null;
            } else if (typeof timerInterval !== 'undefined' && timerInterval) {
                clearInterval(timerInterval);
            }
            
            window.currentClassId = null;
            window.currentActiveStudents = null;
            
            // 5. Re-render Launchpad filters and cards
            if (typeof window.renderWelcomeLaunchpad === 'function') {
                window.renderWelcomeLaunchpad();
            }
        });
    }

    if (DOM.btnDownloadTemplate) {
        DOM.btnDownloadTemplate.addEventListener('click', async () => {
            try {
                DOM.btnDownloadTemplate.innerHTML = 'جاري التحميل...';
                DOM.btnDownloadTemplate.classList.add('opacity-50', 'pointer-events-none');
                
                if (typeof XLSX !== 'undefined') {
                    const ws = XLSX.utils.aoa_to_sheet([
                        ['رقم مسار (اختياري)', 'الاسم الكامل (إجباري)'],
                        ['M130000001', 'أحمد العلوي'],
                        ['M130000002', 'فاطمة الزهراء الإدريسي']
                    ]);
                    ws['!cols'] = [{ wch: 25 }, { wch: 40 }];
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, 'لائحة التلاميذ');
                    XLSX.writeFile(wb, 'students_template.xlsx');
                } else {
                    const response = await fetch(`${window.API_BASE}/template`, {
                        headers: window.getAuthHeaders()
                    });
                    if (!response.ok) throw new Error('فشل تحميل القالب');
                    
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'students_template.xlsx';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }
                
            } catch (error) {
                await window.showCustomAlert('خطأ في التنزيل', 'حدث خطأ أثناء تحميل القالب الموحد');
            } finally {
                DOM.btnDownloadTemplate.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg> تحميل القالب الموحد`;
                DOM.btnDownloadTemplate.classList.remove('opacity-50', 'pointer-events-none');
            }
        });
    }

    // ============================================================================
    // 2. Global Assessment Shortcuts Listener (Fixed & Resilient)
    // ============================================================================
    document.addEventListener('keydown', function(e) {
        // 1. تجاهل الاختصارات داخل حقول الإدخال
        const activeTag = document.activeElement ? document.activeElement.tagName : '';
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) return;

        // 2. تجاهل الاختصارات إذا كانت هناك أي نافذة منبثقة مفتوحة
        const isAnyModalOpen = document.querySelector('#custom-alert-modal:not(.hidden), #custom-confirm-modal:not(.hidden), #modal-add-class:not(.hidden), #add-class-modal:not(.hidden), #modal-column-mapping:not(.hidden), #student-profile-modal:not(.hidden), #delete-confirm-modal:not(.hidden), #student-delete-modal:not(.hidden)');
        if (isAnyModalOpen) return;

        // 3. التحقق من ظهور بطاقة التقييم
        const assessmentCard = document.getElementById('assessment-card');
        if (!assessmentCard || assessmentCard.classList.contains('hidden')) return;

    const key = e.key;
    const code = e.code;
    const keyLower = key.toLowerCase();
    const settings = window.AppSettings || {};
    const kTimer = (settings.keyTimer || ' ').toLowerCase();
    const kPass = (settings.keyPass || '1').toLowerCase();
    const kFail = (settings.keyFail || '0').toLowerCase();
    const kUndo = (settings.keyUndo || 'z').toLowerCase();

    // Timer
    if (keyLower === kTimer || (kTimer === ' ' && code === 'Space')) {
        e.preventDefault();
        const btnTimer = document.getElementById('btn-start-timer');
        if (btnTimer && !btnTimer.classList.contains('hidden') && btnTimer.offsetParent !== null) {
            btnTimer.click();
        }
        return;
    }

    // Evaluation (Pass/Fail)
    if (keyLower === kPass || keyLower === kFail || (kPass === '1' && code === 'Numpad1') || (kFail === '0' && code === 'Numpad0')) {
        const evalButtons = document.getElementById('evaluation-buttons');
        const canEvaluate = evalButtons &&
            !evalButtons.classList.contains('invisible') &&
            !evalButtons.classList.contains('hidden');

        if (canEvaluate && typeof currentFsm !== 'undefined' && currentFsm && !currentFsm.isComplete) {
            e.preventDefault();
            if (keyLower === kPass || code === 'Numpad1') {
                document.getElementById('btn-pass').click();
            } else {
                document.getElementById('btn-fail').click();
            }
        }
        return;
    }

    // Undo
    if (keyLower === kUndo || (kUndo === 'z' && (code === 'KeyZ' || key === 'ز'))) {
        const btnUndo = document.getElementById('btn-undo');
        if (btnUndo && !btnUndo.classList.contains('pointer-events-none') && btnUndo.offsetParent !== null) {
            e.preventDefault();
            btnUndo.click();
        }
        return;
    }
    });

    // ============================================================================
    // 3. Independent "Enter" Shortcut — تقييم تلميذ آخر / الانتقال للتالي
    // Runs in its own listener so the assessment-card hidden guard (line 2744)
    // cannot block it when the completion-card is visible instead.
    // ============================================================================
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
            const assessmentScreen = document.getElementById('assessment-screen');
            // Check if the overall assessment screen is active
            const isAssessmentActive = assessmentScreen && window.getComputedStyle(assessmentScreen).display !== 'none';

            if (isAssessmentActive) {
                e.preventDefault();
                if (typeof loadNextStudent === 'function') {
                    loadNextStudent();
                }
            }
        }
    });

    // ==========================================
    // UNIVERSAL MODAL CLOSE LOGIC
    // ==========================================
    const allModalIds = ['add-class-modal', 'custom-alert-modal', 'custom-confirm-modal', 'student-profile-modal', 'delete-confirm-modal'];
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            allModalIds.forEach(id => {
                const modal = document.getElementById(id);
                if (modal && !modal.classList.contains('hidden')) {
                    modal.classList.add('hidden');
                }
            });
        }
    });

    document.addEventListener('click', (e) => {
        allModalIds.forEach(id => {
            const modal = document.getElementById(id);
            if (modal && !modal.classList.contains('hidden')) {
                if (e.target === modal || e.target.classList.contains('bg-slate-900/50')) {
                    modal.classList.add('hidden');
                }
            }
        });
    });

    // ==========================================
    // GLOBAL BRIDGE FOR CLASSES MANAGER
    window.loadStudentsIntoAssessment = (newStudents) => {
        students = newStudents; // Update the isolated students array
        window.currentActiveStudents = newStudents;
        if (window.State) window.State.students = newStudents;
        renderStudentList(students); // Call the isolated render function
    };

    // SIDEBAR HOVER & PIN LOGIC
    // ==========================================
    const sidebar = document.getElementById('main-sidebar');
    const mainContent = document.getElementById('main-content');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle');
    const navTexts = document.querySelectorAll('.nav-text');
    const chevron = document.getElementById('sidebar-chevron');
    const sidebarTitle = document.getElementById('sidebar-title');
    
    let isPinned = localStorage.getItem('ra2ida_sidebar_pinned') === 'true';
    
    function expandSidebar(pushContent = false) {
        sidebar.classList.remove('w-20');
        sidebar.classList.add('w-64');
        
        if (pushContent) {
            mainContent.classList.remove('mr-20');
            mainContent.classList.add('mr-64');
        }
        
        navTexts.forEach(span => span.classList.remove('opacity-0', 'w-0', 'overflow-hidden'));
        chevron.classList.remove('rotate-180');
        if (sidebarTitle) sidebarTitle.classList.remove('opacity-0', 'w-0', 'hidden');
    }
    
    function collapseSidebar() {
        sidebar.classList.remove('w-64');
        sidebar.classList.add('w-20');
        
        mainContent.classList.remove('mr-64');
        mainContent.classList.add('mr-20');
        
        navTexts.forEach(span => span.classList.add('opacity-0', 'w-0', 'overflow-hidden'));
        chevron.classList.add('rotate-180');
        if (sidebarTitle) sidebarTitle.classList.add('opacity-0', 'w-0', 'hidden');
    }

    if (sidebar) {
        if (isPinned) {
            expandSidebar(true);
        } else {
            collapseSidebar();
        }
        
        sidebar.addEventListener('mouseenter', () => {
            if (!isPinned) expandSidebar(false); // Expand over content
        });
        
        sidebar.addEventListener('mouseleave', () => {
            if (!isPinned) collapseSidebar();
        });
    }

    if (sidebarToggleBtn) {
        sidebarToggleBtn.addEventListener('click', () => {
            isPinned = !isPinned;
            localStorage.setItem('ra2ida_sidebar_pinned', isPinned);
            if (isPinned) {
                expandSidebar(true); // Pinned: push content
            } else {
                collapseSidebar(); // Unpinned: collapse immediately
            }
        });
    }

});

    window.jumpToAssessment = async (classId) => {
        window.currentClassId = classId;
        const quickSelect = document.getElementById('quick-class-select');
        if (quickSelect && quickSelect.options.length <= 1) {
            if (typeof window.initQuickClassSelector === 'function') {
                await window.initQuickClassSelector();
            }
        }
        if(quickSelect) {
            quickSelect.classList.remove('hidden');
            quickSelect.value = classId;
            // Dispatch change event to load students automatically
            quickSelect.dispatchEvent(new Event('change'));
        }
        window.switchScreen('assessment-screen', document.getElementById('nav-assessment'));
    };

    // ==========================================
    // DASHBOARD ENGINE
    // ==========================================
    let dashCompareChart = null;

    window.initDashboard = async () => {
        try {
            const classes = await window.LocalDB.getClasses();
            if (!classes || classes.length === 0) return; // Wait for user to add classes

            // 1. Calculate Global KPIs
            const totalClasses = classes.length;
            let totalStudents = 0;
            let totalEvaluated = 0;
            
            classes.forEach(c => {
                totalStudents += c.student_count;
                totalEvaluated += c.evaluated_count;
            });
            
            const overallProgress = totalStudents > 0 ? Math.round((totalEvaluated / totalStudents) * 100) : 0;
            
            document.getElementById('dash-kpi-classes').innerText = totalClasses;
            document.getElementById('dash-kpi-students').innerText = totalStudents;
            document.getElementById('dash-kpi-progress').innerText = overallProgress + '%';
            
            // 2. Prepare Data for Comparison Chart (Top 10 classes to avoid clutter)
            const sortedForChart = [...classes].sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true})).slice(0, 10);
            const chartLabels = sortedForChart.map(c => c.name);
            const chartData = sortedForChart.map(c => c.student_count > 0 ? Math.round((c.evaluated_count / c.student_count) * 100) : 0);
            
        const chartContainer = document.getElementById('dash-chart-compare-container');
        if (chartContainer) {
            let chartHtml = `
            <div class="flex-1 flex items-end justify-around gap-2 sm:gap-6 pt-12 px-2 sm:px-4 border-b border-slate-200/50 dark:border-white/10 pb-4 relative h-full min-w-max sm:min-w-0">
                <div class="absolute inset-x-0 top-0 border-b border-slate-200/50 dark:border-white/5"><span class="font-mono text-[10px] text-slate-400 dark:text-white/20 pl-2">100%</span></div>
                <div class="absolute inset-x-0 top-1/4 border-b border-slate-200/50 dark:border-white/5"><span class="font-mono text-[10px] text-slate-400 dark:text-white/20 pl-2">75%</span></div>
                <div class="absolute inset-x-0 top-2/4 border-b border-slate-200/50 dark:border-white/5"><span class="font-mono text-[10px] text-slate-400 dark:text-white/20 pl-2">50%</span></div>
                <div class="absolute inset-x-0 top-3/4 border-b border-slate-200/50 dark:border-white/5"><span class="font-mono text-[10px] text-slate-400 dark:text-white/20 pl-2">25%</span></div>
            `;

            sortedForChart.forEach(cls => {
                const val = cls.student_count > 0 ? Math.round((cls.evaluated_count / cls.student_count) * 100) : 0;
                const isDark = document.documentElement.classList.contains('dark');
                
                let colorGrad, textColor, darkGlow;
                if (val === 100) {
                    colorGrad   = isDark ? 'linear-gradient(180deg, #34d399, #059669)' : 'linear-gradient(180deg, #10b981, #059669)';
                    textColor   = isDark ? '#34d399' : '#059669';
                    darkGlow    = 'rgba(16,185,129,0.35)';
                } else if (val >= 50) {
                    colorGrad   = isDark ? 'linear-gradient(180deg, #818cf8, #4f46e5)' : 'linear-gradient(180deg, #6366f1, #4338ca)';
                    textColor   = isDark ? '#818cf8' : '#4f46e5';
                    darkGlow    = 'rgba(99,102,241,0.35)';
                } else if (val > 0) {
                    colorGrad   = isDark ? 'linear-gradient(180deg, #fbbf24, #d97706)' : 'linear-gradient(180deg, #f59e0b, #d97706)';
                    textColor   = isDark ? '#fbbf24' : '#d97706';
                    darkGlow    = 'rgba(245,158,11,0.35)';
                } else {
                    colorGrad   = 'linear-gradient(180deg, #94a3b8, #64748b)';
                    textColor   = isDark ? '#64748b' : '#94a3b8';
                    darkGlow    = 'rgba(148,163,184,0.2)';
                }

                const barShadow = isDark ? `box-shadow:0 -6px 16px ${darkGlow};` : '';

                chartHtml += `
                <div class="bar-column flex-1 flex flex-col items-center h-full justify-end z-10 min-w-[32px] sm:max-w-[50px] mx-1 sm:mx-0 group relative">
                    <span class="font-cairo font-black text-[10px] sm:text-xs tabular-nums mb-2" style="color:${textColor}">${window.escapeHTML(val)}%</span>
                    <div class="w-full rounded-t-xl relative overflow-hidden h-full bg-slate-100/60 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.06] border-b-0">
                        <div class="bar-fill-dynamic absolute bottom-0 inset-x-0 rounded-t-xl" data-height="${window.escapeHTML(val)}%" style="height:0%;background:${colorGrad};${barShadow}"></div>
                    </div>
                    <div class="text-center mt-3 h-6">
                        <span class="block font-cairo font-bold text-[10px] sm:text-[11px] text-slate-700 dark:text-white truncate w-12 sm:w-full">${cls.name}</span>
                    </div>
                    <div class="absolute -top-10 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800 text-white text-[10px] sm:text-xs py-1 px-2 rounded-lg pointer-events-none whitespace-nowrap z-50 shadow-xl border border-white/10">
                        ${window.escapeHTML(val)}% (${cls.evaluated_count} من ${cls.student_count})
                    </div>
                </div>
                `;
            });

            chartHtml += `</div>`;
            chartContainer.innerHTML = chartHtml;
        }

        // 3. Generate Task Tracking (متابعة المهام)
        const insightsContainer = document.getElementById('dash-insights-container');
        
        // Remove padding/scroll from the parent to rely on panels
        insightsContainer.className = "flex-1 flex flex-col h-full";

        const notStarted = classes.filter(c => c.student_count > 0 && c.evaluated_count === 0);
        const inProgress = classes.filter(c => c.student_count > 0 && c.evaluated_count > 0 && c.evaluated_count < c.student_count);
        const completedClasses = classes.filter(c => c.student_count > 0 && c.student_count === c.evaluated_count);
        
        inProgress.sort((a, b) => (b.evaluated_count/b.student_count) - (a.evaluated_count/a.student_count));

        let html = `
        <!-- Tabs Header -->
        <div class="flex p-1 bg-slate-100 dark:bg-white/5 rounded-2xl mb-4 shrink-0 shadow-inner">
            <button id="tab-inprogress" onclick="window.switchInsightTab('inprogress')" class="insight-tab flex-1 py-2 text-xs font-bold rounded-xl bg-white dark:bg-white/10 text-indigo-700 dark:text-white shadow-sm border border-slate-200/50 dark:border-transparent transition-all flex items-center justify-center gap-1.5">
                <svg class="w-3.5 h-3.5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg> قيد الإنجاز
            </button>
            <button id="tab-notstarted" onclick="window.switchInsightTab('notstarted')" class="insight-tab flex-1 py-2 text-xs font-bold rounded-xl text-slate-400 dark:text-white/40 hover:text-slate-600 dark:hover:text-white/70 transition-all flex items-center justify-center gap-1.5">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> لم تبدأ
            </button>
            <button id="tab-completed" onclick="window.switchInsightTab('completed')" class="insight-tab flex-1 py-2 text-xs font-bold rounded-xl text-slate-400 dark:text-white/40 hover:text-slate-600 dark:hover:text-white/70 transition-all flex items-center justify-center gap-1.5">
                <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> مكتملة
            </button>
        </div>
        
        <!-- Panels Container -->
        <div class="relative flex-1 overflow-hidden min-h-[220px]">
        `;

        // Panel: In Progress
        html += `<div id="panel-inprogress" class="insight-panel absolute inset-0 overflow-y-auto custom-scrollbar pr-1 pb-4 flex flex-col gap-3">`;
        if (inProgress.length > 0) {
            inProgress.forEach(cls => {
                const pct = Math.round((cls.evaluated_count/cls.student_count)*100);
                html += `
                <div class="p-3 bg-indigo-50/40 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-500/20 rounded-xl flex items-center justify-between hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors">
                    <div>
                        <p class="text-sm font-bold text-slate-800 dark:text-indigo-100 font-cairo">${cls.name}</p>
                        <p class="text-xs text-indigo-500 dark:text-indigo-300/70 font-semibold tabular-nums">متوقف عند ${pct}%</p>
                    </div>
                    <button onclick="window.jumpToAssessment('${cls.id}')" class="px-4 py-1.5 bg-indigo-50 text-indigo-700 font-bold text-[11px] rounded-lg border border-indigo-100 dark:bg-indigo-500/20 dark:text-indigo-300 dark:border-indigo-500/30 hover:bg-indigo-600 hover:text-white dark:hover:bg-indigo-500/40 transition-all">متابعة</button>
                </div>
                `;
            });
        } else {
            html += `<div class="flex-1 flex items-center justify-center text-xs font-bold text-slate-400">لا توجد أقسام قيد الإنجاز حالياً.</div>`;
        }
        html += `</div>`;

        // Panel: Not Started
        html += `<div id="panel-notstarted" class="insight-panel absolute inset-0 overflow-y-auto custom-scrollbar pr-1 pb-4 flex flex-col gap-3 hidden">`;
        if (notStarted.length > 0) {
            notStarted.forEach(cls => {
                html += `
                <div class="p-3 bg-slate-50 dark:bg-white/[0.02] border border-slate-200/80 dark:border-white/5 rounded-xl flex items-center justify-between hover:bg-slate-100 dark:hover:bg-white/5 transition-colors">
                    <div>
                        <p class="text-sm font-bold text-slate-700 dark:text-slate-200">${cls.name}</p>
                        <p class="text-xs text-slate-400 dark:text-slate-400/70">ينتظر بدء التقويم</p>
                    </div>
                    <button onclick="window.jumpToAssessment('${cls.id}')" class="px-4 py-1.5 bg-indigo-600 text-white font-bold text-[11px] rounded-lg dark:bg-white/10 dark:text-white dark:hover:bg-white/20 hover:bg-indigo-700 transition-all shadow-sm shadow-indigo-200 dark:shadow-none">بدء التقويم</button>
                </div>
                `;
            });
        } else {
            html += `<div class="flex-1 flex items-center justify-center text-xs font-bold text-slate-400">جميع الأقسام بدأت التقييم!</div>`;
        }
        html += `</div>`;

        // Panel: Completed
        html += `<div id="panel-completed" class="insight-panel absolute inset-0 overflow-y-auto custom-scrollbar pr-1 pb-4 flex flex-col gap-3 hidden">`;
        if (completedClasses.length > 0) {
            completedClasses.forEach(cls => {
                html += `
                <div class="p-3 bg-emerald-50/40 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-500/20 rounded-xl flex items-center justify-between hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors">
                    <div>
                        <p class="text-sm font-bold text-emerald-900 dark:text-emerald-100">${cls.name}</p>
                        <p class="text-xs text-emerald-600 dark:text-emerald-300/70">مكتمل 100%</p>
                    </div>
                    <button onclick="window.jumpToAssessment('${cls.id}')" class="px-4 py-1.5 bg-emerald-50 text-emerald-700 font-bold text-[11px] rounded-lg border border-emerald-100 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-500/30 hover:bg-emerald-600 hover:text-white dark:hover:bg-emerald-500/40 transition-all">النتائج</button>
                </div>
                `;
            });
        } else {
            html += `<div class="flex-1 flex items-center justify-center text-xs font-bold text-slate-400">لا توجد أقسام مكتملة بعد.</div>`;
        }
        html += `</div>`;

        html += `</div>`; // End Panels Container
        insightsContainer.innerHTML = html;

        // Ensure global tab switcher exists
        if (!window.switchInsightTab) {
            window.switchInsightTab = (tab) => {
                document.querySelectorAll('.insight-panel').forEach(p => p.classList.add('hidden'));
                const targetPanel = document.getElementById('panel-' + tab);
                if (targetPanel) targetPanel.classList.remove('hidden');
                
                const isDark = document.documentElement.classList.contains('dark');
                document.querySelectorAll('.insight-tab').forEach(b => {
                    b.classList.remove('bg-white', 'text-indigo-700', 'text-slate-800', 'dark:text-white', 'shadow-sm', 'border', 'border-slate-200/50', 'dark:border-transparent');
                    b.classList.add('text-slate-400', 'dark:text-white/40');
                });
                const activeBtn = document.getElementById('tab-' + tab);
                if (activeBtn) {
                    activeBtn.classList.remove('text-slate-400', 'dark:text-white/40');
                    activeBtn.classList.add('bg-white', 'shadow-sm', 'border', 'border-slate-200/50', 'dark:border-transparent',
                        tab === 'completed' ? 'text-emerald-700' : tab === 'notstarted' ? 'text-slate-700' : 'text-indigo-700',
                        'dark:text-white'
                    );
                }
            };
        }


                window.playSnappyEntrance('#dash-kpi-grid > div', 15);
                window.playSnappyEntrance(['#dash-chart-compare-container', '#dash-insights-container'], 15);
        if (typeof gsap !== 'undefined') {
            gsap.to('.bar-fill-dynamic', {
                height: (i, el) => el.getAttribute('data-height'),
                duration: 1.2,
                ease: 'power3.out',
                delay: 0.2
            });
        }

        } catch(e) { console.error('Dashboard Engine Error:', e); }
    };

    // ==========================================
    // ANALYTICS DASHBOARD ENGINE
    // ==========================================
    let chartDoughnutInstance = null;
    let chartBarInstance = null;
    let analyticsFetchedClasses = [];

    window.initAnalyticsDashboard = async () => {
        try {
            const classes = await window.LocalDB.getClasses();
            classes.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));
            analyticsFetchedClasses = classes;
            
            const levels = [...new Set(classes.map(c => c.level))];
            const levelNames = {'1APIC': 'الأولى إعدادي', '2APIC': 'الثانية إعدادي', '3APIC': 'الثالثة إعدادي'};
            
            const levelTabs = document.getElementById('analytics-level-tabs');
            if (levelTabs) {
                levelTabs.innerHTML = levels.map(lvl => `
                    <button onclick="selectAnalyticsLevel('${lvl}')" data-lvl="${lvl}" class="analytics-lvl-btn px-6 py-2.5 rounded-xl font-bold text-sm text-slate-500 hover:text-slate-800 dark:text-white transition-all">
                        ${levelNames[lvl] || lvl}
                    </button>
                `).join('');
            }
            
            const classTabs = document.getElementById('analytics-class-tabs');
            if (classTabs) classTabs.innerHTML = '';
        } catch(e) { console.error('Failed to load classes for analytics', e); }
    };

    window.selectAnalyticsLevel = (level) => {
        // Style active Level tab
        document.querySelectorAll('.analytics-lvl-btn').forEach(btn => {
            if (btn.dataset.lvl === level) {
                btn.className = 'analytics-lvl-btn px-6 py-2.5 rounded-xl font-bold text-sm bg-white text-indigo-600 shadow-sm border border-slate-100 transition-all dark:bg-indigo-500/20 dark:border-indigo-500/50 dark:text-indigo-300 dark:shadow-[0_0_15px_rgba(99,102,241,0.3)] z-10 relative';
            } else {
                btn.className = 'analytics-lvl-btn px-6 py-2.5 rounded-xl font-bold text-sm text-slate-500 hover:text-slate-800 transition-all hover:bg-slate-200/50 dark:text-slate-400 dark:hover:text-indigo-200 dark:hover:bg-white/10 dark:hover:border-white/10 z-10 relative border border-transparent';
            }
        });

        // Build Class sub-tabs
        const levelClasses = analyticsFetchedClasses.filter(c => c.level === level);
        const classTabs = document.getElementById('analytics-class-tabs');
        
        // Removed emoji, added window. prefix
        let html = `<button onclick="window.loadClassAnalytics('level-${level}')" data-cls="level-${level}" class="analytics-cls-btn px-5 py-2 rounded-xl font-bold text-xs transition-all shadow-sm bg-indigo-50 text-indigo-600 border border-indigo-100 dark:bg-indigo-500/20 dark:border-indigo-500/50 dark:text-indigo-300 dark:shadow-[0_0_15px_rgba(99,102,241,0.3)]">تحليل شامل للمستوى</button>`;
        
        html += levelClasses.map(c => `
            <button onclick="window.loadClassAnalytics('${c.id}')" data-cls="${c.id}" class="analytics-cls-btn px-5 py-2 rounded-xl font-bold text-xs transition-all bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 hover:text-indigo-600 dark:bg-white/5 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-indigo-300">
                ${window.escapeHTML(c.name)}
            </button>
        `).join('');
        
        if (classTabs) {
            classTabs.innerHTML = html;
            if (typeof gsap !== 'undefined') {
                gsap.fromTo('.analytics-cls-btn', {opacity: 0, y: -10}, {opacity: 1, y: 0, duration: 0.3, stagger: 0.05});
            }
        }
        
        // Auto-load Macro analysis
        if (typeof window.loadClassAnalytics === 'function') {
            window.loadClassAnalytics(`level-${level}`);
        }
    };

    window.loadClassAnalytics = async (selectedValue) => {
        const emptyState = document.getElementById('analytics-empty-state');
        const contentState = document.getElementById('analytics-content');
        
        if (!selectedValue) {
            emptyState.classList.remove('hidden');
            contentState.classList.add('hidden');
            contentState.classList.remove('flex');
            return;
        }

        try {
            let students = [];
            let dynamicTitle = "التحليل والتقارير";
            
            if (selectedValue.startsWith('level-')) {
                const targetLevel = selectedValue.replace('level-', '');
                const levelNames = {'1APIC': 'الأولى إعدادي', '2APIC': 'الثانية إعدادي', '3APIC': 'الثالثة إعدادي'};
                dynamicTitle = `تحليل شامل: ${levelNames[targetLevel] || targetLevel}`;
                
                const allCls = await window.LocalDB.getClasses();
                const levelClasses = allCls.filter(c => c.level === targetLevel);
                
                if (levelClasses.length > 0) {
                    const studentPromises = levelClasses.map(c => window.LocalDB.getClassStudents(c.id));
                    const nestedStudents = await Promise.all(studentPromises);
                    students = nestedStudents.flat();
                }
            } else {
                students = await window.LocalDB.getClassStudents(selectedValue);
                const targetClass = analyticsFetchedClasses.find(c => String(c.id) === String(selectedValue));
                const selectedText = targetClass ? targetClass.name : "القسم المحدد";
                dynamicTitle = `تحليل القسم: ${selectedText}`;
            }
            
            document.getElementById('analytics-main-title').innerText = dynamicTitle;
            
            // Style active Class tab
            document.querySelectorAll('.analytics-cls-btn').forEach(btn => {
                if (btn.dataset.cls === String(selectedValue)) {
                    btn.className = `analytics-cls-btn px-5 py-2 rounded-xl font-bold text-xs transition-all shadow-sm bg-indigo-50 text-indigo-600 border border-indigo-100 dark:bg-indigo-500/20 dark:border-indigo-500/50 dark:text-indigo-300 dark:shadow-[0_0_15px_rgba(99,102,241,0.3)]`;
                } else {
                    btn.className = `analytics-cls-btn px-5 py-2 rounded-xl font-bold text-xs transition-all bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 hover:text-indigo-600 dark:bg-white/5 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-indigo-300`;
                }
            });
            
            emptyState.classList.add('hidden');
            contentState.classList.remove('hidden');
            contentState.classList.add('flex');
            
            // 1. Calculate KPIs
            const total = students.length;
            const evaluated = students.filter(s => s.status === 'evaluated');
            const absent = students.filter(s => s.status === 'absent');
            
            const evaluatedPct = total > 0 ? Math.round((evaluated.length / total) * 100) : 0;
            const absentPct = total > 0 ? Math.round((absent.length / total) * 100) : 0;
            
            document.getElementById('kpi-total').innerText = total;
            document.getElementById('kpi-evaluated').innerText = evaluatedPct + '%';
            document.getElementById('kpi-absent').innerText = absentPct + '%';
            
            // 2. Calculate Final Levels
            const levels = { 'اللبنة 1': 0, 'اللبنة 2': 0, 'اللبنة 3': 0 };
            evaluated.forEach(s => {
                if(levels[s.final_level] !== undefined) levels[s.final_level]++;
            });
            
            let dominant = '-';
            let max = 0;
            for (const [lvl, count] of Object.entries(levels)) {
                if (count > max) { max = count; dominant = lvl; }
            }
            document.getElementById('kpi-dominant').innerText = max > 0 ? dominant : '-';
            
            // 3. Render SVG GSAP Doughnut Chart
            {
                const stats = {
                    total: total, // local variable from above
                    levels: levels, // local variable from above
                    absent: absent.length,
                    pending: total - evaluated.length - absent.length
                };

                // Data extraction
                const donutTotal = stats.total || 1; // Prevent division by zero
                const lvl1 = stats.levels['اللبنة 1'] || 0;
                const lvl2 = stats.levels['اللبنة 2'] || 0;
                const lvl3 = stats.levels['اللبنة 3'] || 0;
                const absentCount = stats.absent || 0;
                const pendingCount = stats.pending || 0;

                const dataPoints = [
                    { count: lvl1, color: '#38BDF8', label: 'اللبنة 1' },
                    { count: lvl2, color: '#FBBF24', label: 'اللبنة 2' },
                    { count: lvl3, color: '#10B981', label: 'اللبنة 3' },
                    { count: absentCount, color: '#F43F5E', label: 'غائب' },
                    { count: pendingCount, color: '#6B7280', label: 'في انتظار التقييم' }
                ];

                // Calculate SVG stroke math (radius = 38)
                const circumference = 2 * Math.PI * 38; // ~238.76
                let currentOffset = 0;

                // Export data globally for the hover effect
                window.analyticsDonutData = { total: stats.total };

                dataPoints.forEach((dp, idx) => {
                    const percentage = dp.count / donutTotal;
                    const strokeLength = percentage * circumference;
                    const pctString = Math.round(percentage * 100) + '%';
                    
                    // Update Legend Subtext
                    const subEl = document.getElementById(`ad-leg-sub-${idx}`);
                    if (subEl) subEl.innerText = `${pctString} (${dp.count} تلميذ)`;
                    
                    // Animate SVG Segments
                    const seg = document.getElementById(`ad-seg-${idx}`);
                    if (seg) {
                        if (percentage === 0) {
                            gsap.set(seg, { strokeDasharray: `0 ${circumference}` });
                        } else {
                            // Gap of 2 for visual separation if there are multiple segments
                            const gap = percentage < 1 ? 2 : 0;
                            gsap.to(seg, {
                                strokeDashoffset: -currentOffset,
                                strokeDasharray: `${strokeLength - gap} ${circumference}`,
                                duration: 1,
                                ease: 'power3.out'
                            });
                            currentOffset += strokeLength;
                        }
                    }
                    
                    // Save to global for hover
                    window.analyticsDonutData[`seg_${idx}`] = {
                        val: pctString,
                        sub: `${dp.count} تلميذ`,
                        color: dp.color,
                        label: dp.label
                    };
                });

                // Update Center Total
                const centerVal = document.getElementById('ad-center-val');
                if (centerVal) {
                    centerVal.innerText = stats.total;
                    // Reset inline color to match current theme (overrides leftover style from highlightAD/resetAD)
                    const isDarkNow = document.documentElement.classList.contains('dark');
                    centerVal.style.color = isDarkNow ? '#FFFFFF' : '#1E293B';
                }
            }
            
            // 4. Calculate Stage Bottlenecks
            const stagesKeys = ["LTC", "CTC", "LP", "CP", "LTM", "CTM"];
            const stagesLabels = ["طلاقة قصير", "فهم قصير", "طلاقة فقرة", "فهم فقرة", "طلاقة متوسط", "فهم متوسط"];
            const stagePassRates = stagesKeys.map(key => {
                let passed = 0;
                let attempted = 0;
                evaluated.forEach(s => {
                    if (s.stages && s.stages[key] !== "N/A" && s.stages[key] !== null && s.stages[key] !== undefined) {
                        attempted++;
                        // FSM saves 1 for pass, 0 for fail. Checking strictly for 1, '1', or 'متحكم'
                        if (s.stages[key] === 1 || s.stages[key] === "1" || s.stages[key] === "متحكم") {
                            passed++;
                        }
                    }
                });
                return attempted > 0 ? Math.round((passed / attempted) * 100) : 0;
            });

            // 5. Render Bar Chart (Custom HTML)
            const chartContainer = document.getElementById('analytics-bar-chart-container');
            if (chartContainer) {
                let chartHtml = `
                <div class="flex items-end justify-around gap-2 sm:gap-6 pt-12 px-2 sm:px-4 border-b border-slate-200/50 dark:border-white/10 pb-4 relative min-h-[250px] min-w-max sm:min-w-0" style="height:100%">
                    <div class="absolute inset-x-0 top-0 border-b border-slate-200/50 dark:border-white/5"><span class="font-mono text-[10px] text-slate-400 dark:text-white/20 pl-2">100%</span></div>
                    <div class="absolute inset-x-0 top-1/4 border-b border-slate-200/50 dark:border-white/5"><span class="font-mono text-[10px] text-slate-400 dark:text-white/20 pl-2">75%</span></div>
                    <div class="absolute inset-x-0 top-2/4 border-b border-slate-200/50 dark:border-white/5"><span class="font-mono text-[10px] text-slate-400 dark:text-white/20 pl-2">50%</span></div>
                    <div class="absolute inset-x-0 top-3/4 border-b border-slate-200/50 dark:border-white/5"><span class="font-mono text-[10px] text-slate-400 dark:text-white/20 pl-2">25%</span></div>
                `;

                stagesLabels.forEach((stage, idx) => {
                    const val = stagePassRates[idx];
                    const isDark = document.documentElement.classList.contains('dark');
                    
                    let colorGrad, textColor, darkGlow;
                    if (val >= 70) {
                        colorGrad   = isDark ? 'linear-gradient(180deg, #34d399, #059669)' : 'linear-gradient(180deg, #10b981, #059669)';
                        textColor   = isDark ? '#34d399' : '#059669';
                        darkGlow    = 'rgba(16,185,129,0.35)';
                    } else if (val >= 40) {
                        colorGrad   = isDark ? 'linear-gradient(180deg, #818cf8, #4f46e5)' : 'linear-gradient(180deg, #6366f1, #4338ca)';
                        textColor   = isDark ? '#818cf8' : '#4f46e5';
                        darkGlow    = 'rgba(99,102,241,0.35)';
                    } else if (val > 0) {
                        colorGrad   = isDark ? 'linear-gradient(180deg, #fbbf24, #d97706)' : 'linear-gradient(180deg, #f59e0b, #d97706)';
                        textColor   = isDark ? '#fbbf24' : '#d97706';
                        darkGlow    = 'rgba(245,158,11,0.35)';
                    } else {
                        colorGrad   = 'linear-gradient(180deg, #94a3b8, #64748b)';
                        textColor   = isDark ? '#64748b' : '#94a3b8';
                        darkGlow    = 'rgba(148,163,184,0.2)';
                    }

                    const barShadow = isDark ? `box-shadow:0 -6px 16px ${darkGlow};` : '';

                    chartHtml += `
                    <div class="bar-column flex-1 flex flex-col items-center justify-end z-10 min-w-[32px] sm:max-w-[50px] mx-1 sm:mx-0 group relative" style="height:100%">
                        <span class="font-cairo font-black text-[10px] sm:text-xs tabular-nums mb-2" style="color:${textColor}">${window.escapeHTML(val)}%</span>
                        <div class="w-full rounded-t-xl relative overflow-hidden flex-1 min-h-[40px] bg-slate-100/60 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.06] border-b-0">
                            <div class="analytics-bar-fill-dynamic absolute bottom-0 inset-x-0 rounded-t-xl" data-height="${window.escapeHTML(val)}%" style="height:0%;background:${colorGrad};${barShadow}"></div>
                        </div>
                        <div class="text-center mt-3 h-6">
                            <span class="block font-cairo font-bold text-[10px] sm:text-[11px] text-slate-700 dark:text-white truncate w-12 sm:w-full">${stage}</span>
                        </div>
                    </div>
                    `;
                });
                chartHtml += `</div>`;
                chartContainer.innerHTML = chartHtml;

                if (typeof gsap !== 'undefined') {
                    gsap.to('.analytics-bar-fill-dynamic', {
                        height: (i, el) => el.getAttribute('data-height'),
                        duration: 1.2,
                        ease: 'power3.out',
                        delay: 0.2
                    });
                }
            }
        } catch(e) { console.error('Error computing analytics', e); }
    };



// ==========================================
// NAVIGATION SCREEN TOGGLER
// ==========================================
window.switchScreen = function(screenId, clickedBtn) {
    // Hide all screen sections
    const allScreens = document.querySelectorAll('.screen-section');
    allScreens.forEach(screen => {
        screen.classList.add('hidden');
        screen.style.display = ''; // Clear inline styles so .hidden works
    });

    // Show target screen
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
        targetScreen.classList.remove('hidden');
        if (screenId === 'dashboard-home') {
            if (typeof window.initDashboard === 'function') {
                window.initDashboard();
            }
        }

        if (screenId === 'analytics-screen') {
            if (typeof window.initAnalyticsDashboard === 'function') {
                window.initAnalyticsDashboard();
            }
        }
        
        if (screenId === 'classes-screen') {
            const rosterView = document.getElementById('class-roster-view');
            const listView = document.getElementById('classes-list-view');
            if (rosterView && listView) {
                rosterView.classList.add('hidden');
                listView.classList.remove('hidden');
            }
            // Force fresh data fetch to update progress bars
            if (typeof window.fetchAndRenderClasses === 'function') {
                window.fetchAndRenderClasses();
            }
        }
        
        if (screenId === 'assessment-screen') {
            targetScreen.style.display = 'flex'; // Fix GSAP inline display override bug
            targetScreen.classList.add('flex');
            if (typeof window.initQuickClassSelector === 'function') {
                window.initQuickClassSelector();
            }
            if (typeof window.renderWelcomeLaunchpad === 'function') {
                window.renderWelcomeLaunchpad();
            }
            if (!window.currentClassId) { 
                const welcomeState = document.getElementById('welcome-state'); 
                if (welcomeState) { 
                    welcomeState.classList.remove('hidden'); 
                    if (typeof gsap !== 'undefined') { 
                        gsap.set(welcomeState, { opacity: 1, display: 'block', y: 0 }); 
                    } 
                } 
            }
        }
        
        if (screenId === 'settings-screen') {
            if (typeof window.playSnappyEntrance === 'function') {
                window.playSnappyEntrance('#settings-screen > header, #settings-screen > div > div', 15);
            }
        }
    }

    // Update active state across sidebar buttons
    document.querySelectorAll('#main-sidebar .nav-item').forEach(btn => {
        btn.classList.remove('active');
    });

    if (clickedBtn) {
        clickedBtn.classList.add('active');
    } else {
        // Fallback by screenId mapping
        const navMap = {
            'dashboard-home': '#nav-dashboard',
            'classes-screen': '#nav-classes',
            'assessment-screen': '#nav-assessment',
            'analytics-screen': '#nav-analytics',
            'settings-screen': '#nav-settings'
        };
        if (navMap[screenId]) {
            document.querySelector(navMap[screenId])?.classList.add('active');
        }
    }
};

// ==========================================
// CLASSES MANAGER - MODAL & TAB LOGIC
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    const btnOpenModal = document.getElementById('btn-open-class-modal');
    const btnCloseModal = document.getElementById('btn-close-add-modal') || document.getElementById('btn-close-modal-x');
    const btnCancelModal = document.getElementById('btn-cancel-add-modal') || document.getElementById('btn-cancel-modal');
    const modalBackdrop = document.getElementById('add-class-backdrop');
    const addClassModal = document.getElementById('modal-add-class') || document.getElementById('add-class-modal');

    // Tabs & Containers
    const tabExcel = document.getElementById('tab-mode-excel') || document.getElementById('tab-upload');
    const tabManual = document.getElementById('tab-mode-manual') || document.getElementById('tab-manual');
    const containerExcel = document.getElementById('container-mode-excel') || document.getElementById('content-upload');
    const containerManual = document.getElementById('container-mode-manual') || document.getElementById('content-manual');

    // Modal Toggles
    const openModal = () => {
        if (addClassModal) {
            addClassModal.classList.remove('hidden');
            addClassModal.classList.add('flex');
        }
    };
    
    const closeModal = () => {
        if (addClassModal) {
            addClassModal.classList.add('hidden');
            addClassModal.classList.remove('flex');
        }
    };

    if (btnOpenModal) btnOpenModal.addEventListener('click', openModal);
    if (btnCloseModal) btnCloseModal.addEventListener('click', closeModal);
    if (btnCancelModal) btnCancelModal.addEventListener('click', closeModal);
    if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);

    // Tab Switcher
    if (tabExcel && tabManual && containerExcel && containerManual) {
        tabExcel.addEventListener('click', () => {
            tabExcel.className = 'py-2.5 px-4 rounded-xl font-cairo font-bold text-xs sm:text-sm transition-all duration-200 flex items-center justify-center gap-2 bg-white text-indigo-600 shadow-sm dark:bg-indigo-600 dark:text-white cursor-pointer';
            tabManual.className = 'py-2.5 px-4 rounded-xl font-cairo font-bold text-xs sm:text-sm transition-all duration-200 flex items-center justify-center gap-2 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-transparent shadow-none cursor-pointer';
            containerExcel.classList.remove('hidden');
            containerManual.classList.add('hidden');
        });

        tabManual.addEventListener('click', () => {
            tabManual.className = 'py-2.5 px-4 rounded-xl font-cairo font-bold text-xs sm:text-sm transition-all duration-200 flex items-center justify-center gap-2 bg-white text-indigo-600 shadow-sm dark:bg-indigo-600 dark:text-white cursor-pointer';
            tabExcel.className = 'py-2.5 px-4 rounded-xl font-cairo font-bold text-xs sm:text-sm transition-all duration-200 flex items-center justify-center gap-2 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-transparent shadow-none cursor-pointer';
            containerManual.classList.remove('hidden');
            containerExcel.classList.add('hidden');
        });
    }

    // Dropzone & File Input Handling
    const modalDropZone = document.getElementById('modal-dropzone') || document.getElementById('modal-drop-zone');
    const modalFileInput = document.getElementById('modal-file-input');
    const modalFilesList = document.getElementById('modal-files-list') || document.getElementById('modal-file-list');

    if (modalDropZone && modalFileInput) {
        modalDropZone.addEventListener('click', () => {
            modalFileInput.click();
        });

        modalDropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            modalDropZone.classList.add('border-indigo-500', 'bg-indigo-500/10');
        });

        modalDropZone.addEventListener('dragleave', () => {
            modalDropZone.classList.remove('border-indigo-500', 'bg-indigo-500/10');
        });

        modalDropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            modalDropZone.classList.remove('border-indigo-500', 'bg-indigo-500/10');
            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                modalFileInput.files = e.dataTransfer.files;
                renderSelectedFiles(e.dataTransfer.files);
            }
        });

        const renderSelectedFiles = (files) => {
            if (!modalFilesList) return;
            if (files.length === 0) {
                modalFilesList.innerHTML = '';
                return;
            }
            modalFilesList.innerHTML = Array.from(files).map(file => `
                <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 text-xs">
                    <span class="font-bold text-slate-700 dark:text-slate-200 truncate">${window.escapeHTML(file.name)}</span>
                    <span class="text-[10px] text-slate-400 shrink-0 font-mono">${(file.size / 1024).toFixed(1)} KB</span>
                </div>
            `).join('');
        };

        modalFileInput.addEventListener('change', (e) => {
            renderSelectedFiles(e.target.files);
        });
    }

    async function importMultipleFilesSafely(files) {
        const successfulImports = [];
        const failedImports = [];

        for (const file of files) {
            try {
                const data = await window.parseMassarWorkbook(file);
                await window.LocalDB.saveClassWithStudents(data.className, data.level, data.students);
                successfulImports.push(data.className);
            } catch (err) {
                console.error('Failed to parse file:', file.name, err);
                failedImports.push({ file: file.name, error: err.message || 'تعذر استيراد الملف' });
            }
        }

        if (failedImports.length > 0) {
            const details = failedImports.map(f => `• ${window.escapeHTML(f.file)}: ${window.escapeHTML(f.error)}`).join('\n');
            await window.showCustomAlert('تقرير استيراد الملفات', `تم استيراد ${successfulImports.length} قسم بنجاح.\nتعذر استيراد:\n${details}`);
        } else if (successfulImports.length > 0) {
            if (typeof window.showToast === 'function') {
                window.showToast(`تم استيراد جميع الأقسام (${successfulImports.length}) بنجاح`, 'success');
            }
        }
        return { successCount: successfulImports.length, failedImports };
    }
    window.importMultipleFilesSafely = importMultipleFilesSafely;
    window.processMultipleExcelFiles = importMultipleFilesSafely;

    // Save Classes Logic
    const btnSaveClasses = document.getElementById('btn-save-classes');
    if (btnSaveClasses) {
        btnSaveClasses.addEventListener('click', async () => {
            const isManual = containerManual && !containerManual.classList.contains('hidden');
            const errorMsgEl = document.getElementById('modal-error-msg');
            
            const showError = async (msg) => {
                if (errorMsgEl) {
                    errorMsgEl.innerText = msg;
                    errorMsgEl.classList.remove('hidden');
                } else if (typeof window.showCustomAlert === 'function') {
                    await window.showCustomAlert('تنبيه', msg);
                }
            };
            
            if (errorMsgEl) errorMsgEl.classList.add('hidden');

            const originalText = btnSaveClasses.innerHTML;
            btnSaveClasses.innerHTML = '<span>جاري الحفظ...</span>';
            btnSaveClasses.disabled = true;
            btnSaveClasses.classList.add('opacity-75', 'cursor-not-allowed');

            try {
                if (!isManual) {
                    // Upload Excel Logic
                    const files = modalFileInput ? modalFileInput.files : [];
                    if (files.length === 0) {
                        showError('يرجى اختيار ملف مسار واحد على الأقل.');
                        throw new Error('SILENT');
                    }

                    await window.importMultipleFilesSafely(files);
                } else {
                    // Manual Input Logic
                    const classNameInput = document.getElementById('manual-class-name')?.value.trim();
                    const manualLevel = document.getElementById('manual-class-level')?.value || '1APIC';
                    const manualText = (document.getElementById('manual-students-text')?.value || document.getElementById('manual-names')?.value || '').trim();

                    if (!classNameInput || !manualText) {
                        showError('يرجى إدخال اسم القسم ولائحة التلاميذ.');
                        throw new Error('SILENT');
                    }

                    const lines = manualText.split('\n').map(l => l.trim()).filter(l => l !== '');
                    const studentsList = lines.map((line, idx) => {
                        // Check if line contains massar id pattern (e.g. D132456789 or G123456789)
                        const massarMatch = line.match(/\b([A-Z]\d{8,10})\b/i);
                        let massar = 'غير متوفر';
                        let name = line;
                        if (massarMatch) {
                            massar = massarMatch[1].toUpperCase();
                            name = line.replace(massarMatch[0], '').replace(/[-–:,|]/g, '').trim();
                        }
                        return {
                            name: name || `تلميذ ${idx + 1}`,
                            massar_id: massar
                        };
                    });

                    await window.LocalDB.saveClassWithStudents(classNameInput, manualLevel, studentsList);
                }

                // Success - Reset UI
                closeModal();
                if (modalFileInput) modalFileInput.value = '';
                if (modalFilesList) modalFilesList.innerHTML = '';
                
                const manualNameEl = document.getElementById('manual-class-name');
                const manualTextEl = document.getElementById('manual-students-text') || document.getElementById('manual-names');
                if (manualNameEl) manualNameEl.value = '';
                if (manualTextEl) manualTextEl.value = '';

                await fetchAndRenderClasses();
                if (typeof window.initQuickClassSelector === 'function') window.initQuickClassSelector();
                if (typeof window.renderWelcomeLaunchpad === 'function') window.renderWelcomeLaunchpad();
                if (typeof window.initDashboard === 'function') window.initDashboard();

            } catch (error) {
                if (error.message !== 'SILENT') {
                    console.error(error);
                    showError(error.message || 'حدث خطأ أثناء حفظ القسم');
                }
            } finally {
                btnSaveClasses.innerHTML = originalText;
                btnSaveClasses.disabled = false;
                btnSaveClasses.classList.remove('opacity-75', 'cursor-not-allowed');
            }
        });
    }

    // Fetch and Render Classes Logic
    const fetchAndRenderClasses = async () => {
        const classesGrid = document.getElementById('classes-grid');
        if(!classesGrid) return;

        // Inject Skeleton Loader
        classesGrid.innerHTML = Array(3).fill('<div class="bg-white dark:bg-white/5 backdrop-blur-xl dark:border-white/10 rounded-3xl p-6 shadow-sm dark:shadow-none border border-slate-100 animate-pulse h-48 flex flex-col"><div class="h-6 bg-slate-200 rounded w-1/2 mb-6"></div><div class="w-full bg-slate-200 rounded-full h-2.5 mb-8 mt-auto"></div><div class="h-10 bg-slate-200 rounded-xl w-full"></div></div>').join('');

        try {
            const classes = await window.LocalDB.getClasses();
            
            const emptyState = document.getElementById('classes-empty-state');
            const headerActions = document.getElementById('classes-header-actions');
            
            if(classes.length === 0) {
                if(emptyState) emptyState.classList.remove('hidden');
                if(headerActions) headerActions.classList.add('opacity-0', 'pointer-events-none');
                classesGrid.innerHTML = '';
                return;
            }
            
            if(emptyState) emptyState.classList.add('hidden');
            if(headerActions) headerActions.classList.remove('opacity-0', 'pointer-events-none');

            // Natural Sort
            classes.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));
            
            // Group by level
            const grouped = classes.reduce((acc, c) => {
                if (!acc[c.level]) acc[c.level] = [];
                acc[c.level].push(c);
                return acc;
            }, {});
            
            const levelColors = {
                '1APIC': 'bg-sky-50 text-sky-600',
                '2APIC': 'bg-indigo-50 text-indigo-600',
                '3APIC': 'bg-amber-50 dark:bg-amber-900/20 dark:border dark:border-amber-800/30 text-amber-600'
            };
            
            let html = '';
            for (const [level, classList] of Object.entries(grouped)) {
                html += `<h3 class="col-span-full flex items-center justify-between mb-4 pb-2 border-b-2 border-transparent text-xl font-bold text-slate-700 dark:text-slate-300 mt-6 relative before:absolute before:bottom-0 before:left-0 before:w-full before:h-[2px] before:bg-gradient-to-r before:from-transparent before:via-indigo-500/50 before:to-transparent">مستوى ${level}</h3>`;
                html += classList.map(c => {
                    const percent = c.student_count > 0 ? Math.round((c.evaluated_count / c.student_count) * 100) : 0;
                    let barColor = 'bg-slate-200';
                    let barGlow = '';
                    let btnClass = '';
                    let btnText = 'فتح القسم';
                    let textStatusColor = 'text-slate-500';

                    if (percent === 100) {
                        barColor = 'bg-gradient-to-r from-emerald-400 to-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.5)]';
                        barGlow = '';
                        btnClass = 'w-full py-2.5 rounded-xl font-bold transition-all duration-300 bg-emerald-500 text-white hover:bg-emerald-600 shadow-sm border border-transparent dark:bg-emerald-600/20 dark:border dark:border-emerald-400/[0.4] dark:text-emerald-50 dark:shadow-[0_4px_20px_rgba(16,185,129,0.3)] dark:hover:shadow-[0_4px_25px_rgba(16,185,129,0.5)] dark:hover:bg-emerald-600/30';
                        btnText = 'مكتمل - عرض اللائحة';
                        textStatusColor = 'text-emerald-400';
                    } else if (percent > 0) {
                        barColor = 'bg-gradient-to-r from-amber-400 to-yellow-300 shadow-[0_0_10px_rgba(251,191,36,0.5)]';
                        barGlow = '';
                        btnClass = 'w-full py-2.5 rounded-xl font-bold transition-all duration-300 bg-amber-500 text-white hover:bg-amber-600 shadow-sm border border-transparent dark:bg-amber-500/10 dark:border-amber-500/50 dark:text-amber-400 dark:hover:bg-amber-500/20 dark:hover:shadow-[0_0_15px_rgba(245,158,11,0.4)]';
                        btnText = 'إكمال التقويم';
                        textStatusColor = 'text-amber-400';
                    } else {
                        barColor = 'bg-transparent';
                        btnClass = 'w-full py-2.5 rounded-xl font-bold transition-all duration-300 bg-slate-100 text-slate-500 hover:bg-slate-200 border border-slate-200 dark:bg-white/5 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10';
                    }

                    return `
                    <div class="kpi-card kpi-card--indigo rounded-2xl p-5 flex flex-col hover:-translate-y-1">
                        <div class="flex justify-between items-start mb-6">
                            <div class="flex items-center justify-between w-full gap-2">
                                <span class="truncate font-extrabold text-xl text-slate-800 dark:text-white" title="${window.escapeHTML(c.name)}">${window.escapeHTML(c.name)}</span>
                                <div class="flex items-center gap-1 shrink-0">
                                    <button onclick="renameClass(this, ${c.id}, '${c.name.replace(/'/g, "\\'")}')" class="w-7 h-7 flex items-center justify-center rounded-full bg-slate-50 text-slate-400 hover:bg-indigo-50 dark:bg-indigo-500/10 dark:border dark:border-indigo-500/20 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors" title="تغيير اسم القسم">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                                    </button>
                                    <button onclick="event.stopPropagation(); confirmDeleteClass(${c.id})" class="text-slate-400 hover:text-red-500 transition-colors cursor-pointer dark:text-slate-400 dark:hover:text-rose-400 p-1 rounded-md" title="حذف القسم">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                    </button>
                                </div>
                            </div>
                            <span class="bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 font-bold px-2 py-1 rounded text-xs border border-transparent dark:border-indigo-500/30 shadow-[0_0_10px_rgba(99,102,241,0.2)]">${window.escapeHTML(c.level)}</span>
                        </div>
                        
                        <div class="mb-8 mt-auto">
                            <div class="flex justify-between items-end mb-3">
                                <span class="bg-white dark:bg-white/10 border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-200 rounded-full px-3 py-1 text-sm font-medium">${c.evaluated_count} من ${c.student_count} تم تقييمهم</span>
                                <span class="${textStatusColor} font-extrabold text-xl leading-none">${percent}%</span>
                            </div>
                            <div class="w-full bg-slate-100/50 dark:bg-[#0B0F19]/80 rounded-full h-2.5 mb-4 overflow-hidden border border-slate-200/50 dark:border-white/5 shadow-inner dark:shadow-none">
                                <div class="${barColor} h-full rounded-full transition-all duration-1000 ease-out" style="width: ${percent}%"></div>
                            </div>
                        </div>

                        <button onclick="openClass(${c.id})" class="${btnClass}">
                            ${btnText}
                        </button>
                    </div>
                    `;
                }).join('');
            }
            classesGrid.innerHTML = html;
            window.playSnappyEntrance('#classes-grid > div', 15);

            const classesScreen = document.getElementById('classes-screen');
            if (typeof gsap === 'undefined' || !classesScreen || classesScreen.classList.contains('hidden')) {
                document.querySelectorAll('#classes-grid > div').forEach(el => {
                    el.style.opacity = '1';
                    el.style.transform = 'translateY(0)';
                    el.style.transition = 'all 0.5s ease-out';
                });
            }
        } catch (error) {
            console.error(error);
            classesGrid.innerHTML = `
                <div class="col-span-full text-center py-12 text-rose-500 font-bold">
                    حدث خطأ أثناء تحميل الأقسام.
                </div>
            `;
        }
    };

    window.fetchAndRenderClasses = fetchAndRenderClasses;

    // Initial Fetch
    fetchAndRenderClasses();

    window.renameClass = (btn, id, currentName) => {
        const container = btn.closest('.flex.items-center.justify-between.w-full.gap-2');
        const span = container.querySelector('span');
        const actionButtons = container.querySelector('div.flex.items-center');
        
        span.classList.add('hidden');
        actionButtons.classList.add('hidden');
        
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.className = 'w-full px-3 py-1.5 rounded-md text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 z-10 relative bg-white text-slate-900 border border-slate-300 dark:bg-[#0B0F19] dark:text-white dark:border-slate-700 dark:focus:ring-indigo-400';
        
        container.insertBefore(input, actionButtons);
        input.focus();
        
        const saveName = async () => {
            const newName = input.value.trim();
            if (newName === currentName || newName === '') {
                input.remove();
                span.classList.remove('hidden');
                actionButtons.classList.remove('hidden');
                return;
            }
            
            input.disabled = true;
            try {
                await window.LocalDB.renameClass(id, newName);
                
                span.innerText = newName;
                span.title = newName;
                btn.setAttribute('onclick', `renameClass(this, ${id}, '${newName.replace(/'/g, "\\'")}')`);
                
                input.remove();
                span.classList.remove('hidden');
                actionButtons.classList.remove('hidden');
                
                if (typeof window.initQuickClassSelector === 'function') window.initQuickClassSelector();
                if (typeof window.renderWelcomeLaunchpad === 'function') window.renderWelcomeLaunchpad();
                
            } catch (err) {
                await window.showCustomAlert('خطأ في تعديل القسم', 'خطأ: ' + err.message);
                input.disabled = false;
                input.focus();
            }
        };
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveName();
            if (e.key === 'Escape') {
                input.value = currentName;
                saveName(); // reverts back
            }
        });
        
        input.addEventListener('blur', saveName);
    };

    window.openClass = async (id) => {
        window.activeRosterClassId = id;
        try {
            const data = await window.LocalDB.getClassStudents(id);
            window.currentActiveStudents = data;
            
            const evaluatedCount = data.filter(s => s.status !== 'pending').length;
            const btnStart = document.getElementById('btn-start-assessment');
            
            if (evaluatedCount === 0) {
                btnStart.innerText = 'بدء تقويم القسم';
                btnStart.className = 'px-4 py-2 rounded-lg font-medium transition-all duration-300 bg-amber-500 text-white hover:bg-amber-600 shadow-md border border-transparent dark:bg-amber-500/10 dark:border-amber-500/50 dark:text-amber-400 dark:hover:bg-amber-500/20 dark:hover:shadow-[0_0_15px_rgba(245,158,11,0.4)]';
            } else if (evaluatedCount === data.length && data.length > 0) {
                btnStart.innerText = 'مكتمل (تعديل التقويم)';
                btnStart.className = 'px-4 py-2 rounded-lg font-medium transition-all duration-300 bg-emerald-500 text-white hover:bg-emerald-600 shadow-md border border-transparent dark:bg-emerald-500/10 dark:border-emerald-500/50 dark:text-emerald-300 dark:hover:bg-emerald-500/20 dark:hover:shadow-[0_0_15px_rgba(16,185,129,0.4)]';
            } else {
                btnStart.innerText = 'إكمال التقويم';
                btnStart.className = 'px-4 py-2 rounded-lg font-medium transition-all duration-300 bg-amber-500 text-white hover:bg-amber-600 shadow-md border border-transparent dark:bg-amber-500/10 dark:border-amber-500/50 dark:text-amber-400 dark:hover:bg-amber-500/20 dark:hover:shadow-[0_0_15px_rgba(245,158,11,0.4)]';
            }
            
            // Just for the roster view rendering
            let rosterRenderData = data.map(s => ({...s, status: s.status || 'pending'}));
            document.getElementById('classes-list-view').classList.add('hidden');
            document.getElementById('class-roster-view').classList.remove('hidden');
            
            const classes = await window.LocalDB.getClasses();
            const classObj = classes.find(c => c.id === id);
            
            document.getElementById('roster-class-name').innerText = classObj ? classObj.name : 'القسم';
            document.getElementById('roster-class-count').innerText = `عدد التلاميذ: ${data.length}`;
            
            const rosterList = document.getElementById('roster-student-list');
            rosterList.innerHTML = rosterRenderData.map((s, index) => {
                let dotColor, textColor, statusLabel;
                if (s.status === 'pending') {
                    dotColor = 'bg-slate-300'; textColor = 'text-slate-400'; statusLabel = 'لم يُقيّم';
                } else if (s.status === 'absent') {
                    dotColor = 'bg-rose-400'; textColor = 'text-rose-500'; statusLabel = 'غائب';
                } else {
                    dotColor = 'bg-emerald-400'; textColor = 'text-emerald-500'; statusLabel = 'مقوم';
                }
                return `
                    <li onclick="window.openStudentModal(${s.id})" class="grid grid-cols-12 gap-4 p-4 hover:bg-slate-50 dark:hover:bg-white/[0.06] transition-all duration-300 items-center text-sm cursor-pointer group relative border-b border-slate-200 dark:border-solid dark:border-transparent dark:[border-image:linear-gradient(to_right,transparent,rgba(255,255,255,0.15),transparent)_1]">
                        <div class="col-span-1 text-center text-slate-400 font-bold">${s.order_number || index + 1}</div>
                        <div class="col-span-3 font-mono text-slate-500 dark:text-slate-300">${window.escapeHTML(s.massar_id)}</div>
                        <div class="col-span-6 font-bold text-slate-700 dark:text-slate-300">${window.escapeHTML(s.name)}</div>
                        <div class="col-span-2 flex items-center justify-center gap-2">
                            <div class="w-2.5 h-2.5 rounded-full ${dotColor}"></div>
                            <span class="text-xs font-bold ${textColor}">${statusLabel}</span>
                            <div class="opacity-0 group-hover:opacity-100 p-1.5 text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20 hover:shadow-[0_0_15px_rgba(99,102,241,0.3)] border border-transparent hover:border-indigo-500/30 rounded-lg transition-all absolute left-4" title="تعديل">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                            </div>
                        </div>
                    </li>
                `;
            }).join('');
            
        } catch (err) {
            console.error('خطأ في فتح القسم:', err);
        }
    };

    /**
     * Normalizes any level representation (Arabic label or code) into a unified standard key.
     */
    function normalizeAcademicLevel(levelStr) {
        if (!levelStr) return '1APIC';
        const s = String(levelStr).trim();

        if (/^1\s*(?:APIC|AC|AS)|1\s*[\/-]|الأولى/i.test(s)) return '1APIC';
        if (/^2\s*(?:APIC|AC|AS)|2\s*[\/-]|الثانية/i.test(s)) return '2APIC';
        if (/^3\s*(?:APIC|AC|AS)|3\s*[\/-]|الثالثة/i.test(s)) return '3APIC';
        if (/TCS|TCT|جذع/i.test(s)) return 'الجذع المشترك';
        
        return s;
    }

    /**
     * Returns the official Arabic display label for a level key.
     */
    function getLevelArabicLabel(levelKey) {
        const map = {
            '1APIC': 'الأولى إعدادي',
            '2APIC': 'الثانية إعدادي',
            '3APIC': 'الثالثة إعدادي',
            'الجذع المشترك': 'الجذع المشترك'
        };
        return map[levelKey] || levelKey;
    }

    window.startClassAssessment = function(classId) {
        const quickSelect = document.getElementById('quick-class-select');
        if (quickSelect) {
            quickSelect.classList.remove('hidden');
            quickSelect.value = classId;
            quickSelect.dispatchEvent(new Event('change'));
        }
    };

    window.initQuickClassSelector = async () => {
        try {
            const classes = await window.LocalDB.getClasses();
            
            const selectEl = document.getElementById('quick-class-select');
            if (selectEl && classes.length > 0) {
                classes.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));
                const grouped = classes.reduce((acc, c) => {
                    const normLevel = normalizeAcademicLevel(c.level || c.name);
                    if (!acc[normLevel]) acc[normLevel] = [];
                    acc[normLevel].push(c);
                    return acc;
                }, {});
                
                let optionsHtml = '<option class="bg-white dark:bg-[#0B0F19] text-slate-800 dark:text-slate-100 py-1.5" value="">-- اختر القسم للبدء --</option>';
                
                for (const [levelKey, classList] of Object.entries(grouped)) {
                    optionsHtml += `<optgroup class="bg-white dark:bg-[#0B0F19] text-slate-800 dark:text-slate-400 font-bold" label="${getLevelArabicLabel(levelKey)}">`;
                    optionsHtml += classList.map(c => `<option class="bg-white dark:bg-[#0B0F19] text-slate-800 dark:text-slate-100 py-1.5" value="${c.id}">${window.escapeHTML(c.name)}</option>`).join('');
                    optionsHtml += `</optgroup>`;
                }
                
                selectEl.innerHTML = optionsHtml;
                
                if (window.currentClassId) {
                    selectEl.value = window.currentClassId;
                    selectEl.classList.remove('hidden');
                } else {
                    selectEl.classList.add('hidden');
                }
            }
        } catch (err) {
            console.error('Error fetching classes for quick switch:', err);
        }
    };

    window.renderWelcomeLaunchpad = async function(selectedLevel = null) {
        const container = document.getElementById('welcome-classes-grid');
        const filtersContainer = document.getElementById('welcome-level-filters');
        const welcomeState = document.getElementById('welcome-state');
        if (!container || !welcomeState) return;

        try {
            const classes = await window.LocalDB.getClasses();
            if (!classes || classes.length === 0) {
                if (filtersContainer) filtersContainer.innerHTML = '';
                container.innerHTML = `
                    <div class="col-span-full flex flex-col items-center justify-center p-12 text-center bg-white dark:bg-white/5 backdrop-blur-xl dark:border-white/10 rounded-3xl border border-slate-100 shadow-sm dark:shadow-none mt-4">
                        <div class="empty-state-icon">
                            <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
                        </div>
                        <h3 class="text-2xl font-bold text-slate-800 dark:text-white mb-3">لا توجد أقسام للتقييم</h3>
                        <p class="text-slate-500 dark:text-slate-400 mb-8 max-w-sm">لم تقم بإضافة أي أقسام بعد. يرجى التوجه إلى إدارة الأقسام لرفع لوائح التلاميذ.</p>
                        <button onclick="document.getElementById('nav-classes').click()" class="btn btn-primary btn-md">
                            الذهاب لإدارة الأقسام
                        </button>
                    </div>
                `;
                return;
            }

            // 1. Group classes by normalized level
            const levelMap = {};
            classes.forEach(c => {
                const normLevel = normalizeAcademicLevel(c.level || c.name);
                if (!levelMap[normLevel]) levelMap[normLevel] = [];
                levelMap[normLevel].push(c);
            });

            const availableLevels = Object.keys(levelMap);
            if (availableLevels.length === 0) return;

            // 2. Set active level
            let activeLevel = selectedLevel ? normalizeAcademicLevel(selectedLevel) : availableLevels[0];
            if (!availableLevels.includes(activeLevel)) {
                activeLevel = availableLevels[0];
            }

            // 3. Render Level Filter Tabs (Original Soft Pill Design)
            if (filtersContainer) {
                filtersContainer.innerHTML = availableLevels.map(lvl => {
                    const isActive = lvl === activeLevel;
                    const label = getLevelArabicLabel(lvl);
                    const tabClasses = isActive
                        ? 'bg-indigo-50 text-indigo-600 border border-indigo-200/80 shadow-xs dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-500/30'
                        : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200/80 dark:bg-white/5 dark:text-slate-300 dark:border-white/10 dark:hover:bg-white/10';
                    return `
                        <button type="button" 
                            onclick="window.renderWelcomeLaunchpad('${lvl}')"
                            class="px-6 py-2.5 rounded-full font-cairo font-bold text-sm transition-all duration-200 cursor-pointer ${tabClasses}">
                            ${label}
                        </button>
                    `;
                }).join('');
            }

            // 4. Render Class Cards for the Active Level (Original Minimalist Design)
            const targetClasses = levelMap[activeLevel] || [];
            targetClasses.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));

            if (targetClasses.length === 0) {
                container.innerHTML = '<div class="col-span-full text-center text-slate-400 py-8 text-sm font-bold">لا توجد أقسام مسجلة في هذا المستوى</div>';
                return;
            }

            container.innerHTML = targetClasses.map(c => `
                <div onclick="window.startClassAssessment(${c.id})" 
                     class="bento-card glass rounded-2xl p-8 border border-white/60 dark:border-white/10 shadow-xs hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 cursor-pointer flex flex-col justify-center items-center text-center">
                    <h4 class="font-cairo font-black text-2xl text-slate-900 dark:text-white mb-2">
                        ${window.escapeHTML(c.name)}
                    </h4>
                    <p class="text-sm font-medium text-slate-500 dark:text-slate-400">
                        ${c.student_count || 0} تلميذاً
                    </p>
                </div>
            `).join('');

            if (typeof window.playSnappyEntrance === 'function') {
                window.playSnappyEntrance('#welcome-classes-grid > div', 15);
            }
        } catch (err) {
            console.error('Launchpad error:', err);
        }
    };

    const quickClassSelect = document.getElementById('quick-class-select');
    if (quickClassSelect) {
        quickClassSelect.addEventListener('change', async (e) => {
            const classIdToLoad = e.target.value || window.currentClassId;
            if (!classIdToLoad) return;
            window.currentClassId = classIdToLoad;
            
            // Sanitize Workspace before loading new class
            const uiElementsToHide = [
                document.getElementById('assessment-card'),
                document.getElementById('completion-card'),
                document.getElementById('completion-screen'),
                document.getElementById('current-student-info')
            ];

            uiElementsToHide.forEach(el => {
                if (el) {
                    if (typeof gsap !== 'undefined') gsap.set(el, { clearProps: "all" });
                    el.classList.add('hidden');
                    el.classList.remove('flex');
                }
            });

            const welcomeState = document.getElementById('welcome-state');
            if (welcomeState) {
                welcomeState.classList.remove('hidden');
                if (typeof gsap !== 'undefined') {
                    gsap.set(welcomeState, { opacity: 1, display: 'block', y: 0 });
                } else {
                    welcomeState.style.display = 'block';
                }
            }
            
            try {
                const data = await window.LocalDB.getClassStudents(window.currentClassId);
                
                const btnResetApp = document.getElementById('btn-reset-app');
                if (btnResetApp) btnResetApp.classList.remove('hidden');
                
                const emptyState = document.getElementById('sidebar-empty-state');
                if (emptyState) emptyState.remove();
                
                const formattedStudents = data.map(s => ({
                    id: s.id,
                    massar_id: s.massar_id || s.massar_number || s.massarNumber || 'غير متوفر',
                    name: s.name,
                    status: s.status || 'pending',
                    stages: s.stages || { "LTC": "N/A", "CTC": "N/A", "LP": "N/A", "CP": "N/A", "LTM": "N/A", "CTM": "N/A" },
                    final_level: s.final_level || null,
                    order_number: s.order_number
                }));
                
                if (typeof window.loadStudentsIntoAssessment === 'function') {
                    window.loadStudentsIntoAssessment(formattedStudents);
                    window.toggleAssessmentSidebar(true);

                    if (formattedStudents && formattedStudents.length > 0) {
                        const targetStudent = formattedStudents.find(s => s.status === 'pending');
                        if (targetStudent) {
                            setTimeout(() => {
                                if (typeof window.selectStudent === 'function') window.selectStudent(targetStudent);
                            }, 100);
                        } else {
                            const allEvaluated = formattedStudents.every(s => s.status !== 'pending');
                            if (allEvaluated) {
                                setTimeout(() => {
                                    if (typeof window.checkCompletion === 'function') window.checkCompletion();
                                }, 100);
                            } else {
                                const fb = formattedStudents.find(s => s.status !== 'absent') || formattedStudents[0];
                                setTimeout(() => {
                                    if (typeof window.selectStudent === 'function') window.selectStudent(fb);
                                }, 100);
                            }
                        }
                    }
                }
                
            } catch (err) {
                console.error('Quick switch error:', err);
            }
        });
    }

    const btnBackClasses = document.getElementById('btn-back-classes');
    if(btnBackClasses) {
        btnBackClasses.addEventListener('click', () => {
            document.getElementById('class-roster-view').classList.add('hidden');
            document.getElementById('classes-list-view').classList.remove('hidden');
        });
    }

    const btnStartAssessment = document.getElementById('btn-start-assessment');
    if(btnStartAssessment) {
        btnStartAssessment.addEventListener('click', () => {
            const uploadScreen = document.getElementById('upload-screen');
            const dashboardScreen = document.getElementById('dashboard-screen');
            if (uploadScreen) uploadScreen.classList.add('hidden');
            if (dashboardScreen) dashboardScreen.classList.remove('hidden');

            if (window.activeRosterClassId && typeof window.jumpToAssessment === 'function') {
                window.jumpToAssessment(window.activeRosterClassId);
            } else {
                window.switchScreen('assessment-screen', document.getElementById('nav-assessment'));
            }
        });
    }

    // Safe Deletion UI & Logic
    window.confirmDeleteClass = async (id) => {
        const isConfirmed = await window.showCustomConfirm(
            'تأكيد حذف القسم',
            'هل أنت متأكد من رغبتك في حذف هذا القسم وجميع تلاميذه؟ لا يمكن التراجع عن هذه العملية.'
        );
        if (!isConfirmed) return;

        try {
            await window.LocalDB.deleteClass(id);
            await fetchAndRenderClasses();
            if (typeof window.initQuickClassSelector === 'function') window.initQuickClassSelector();
            if (typeof window.renderWelcomeLaunchpad === 'function') window.renderWelcomeLaunchpad();
            if (typeof window.initDashboard === 'function') window.initDashboard();
        } catch (err) {
            await window.showCustomAlert('خطأ في الحذف', err.message);
        }
    };
    
    const btnDeleteAll = document.getElementById('btn-delete-all-classes');
    if (btnDeleteAll) {
        btnDeleteAll.addEventListener('click', async () => {
            const isConfirmed = await window.showCustomConfirm(
                'تأكيد مسح جميع الأقسام',
                'هل أنت متأكد من رغبتك في حذف جميع الأقسام والبيانات؟ لا يمكن التراجع عن هذه العملية.'
            );
            if (!isConfirmed) return;

            try {
                await window.LocalDB.deleteAllClasses();
                await fetchAndRenderClasses();
                if (typeof window.initQuickClassSelector === 'function') window.initQuickClassSelector();
                if (typeof window.renderWelcomeLaunchpad === 'function') window.renderWelcomeLaunchpad();
                if (typeof window.initDashboard === 'function') window.initDashboard();
            } catch (err) {
                await window.showCustomAlert('خطأ في الحذف', err.message);
            }
        });
    }

});

    window.openStudentModal = async (studentId) => {
        try {
            const fetchClassId = (!document.getElementById('classes-screen').classList.contains('hidden') && window.activeRosterClassId) 
                ? window.activeRosterClassId 
                : window.currentClassId;

            if (!fetchClassId) return;
            const students = await window.LocalDB.getClassStudents(fetchClassId);
            const student = students.find(s => String(s.id) === String(studentId));
            if (!student) return;

            document.getElementById('modal-student-id').value = student.id;
            document.getElementById('modal-student-name').value = student.name;
            document.getElementById('modal-student-massar').value = student.massar_id;
            
            const classes = await window.LocalDB.getClasses();
            
            const currentClassObj = classes.find(c => c.id === student.class_id);
            const level = currentClassObj ? currentClassObj.level : null;
            const filteredClasses = level ? classes.filter(c => c.level === level) : classes;
            
            const select = document.getElementById('modal-class-select');
            select.innerHTML = filteredClasses.map(c => `<option class="bg-white dark:bg-[#0B0F19] text-slate-800 dark:text-slate-100 py-1.5" value="${c.id}" ${c.id === student.class_id ? 'selected' : ''}>${window.escapeHTML(c.name)}</option>`).join('');
            
            window.originalModalClassId = student.class_id;
            document.getElementById('modal-order-number-container').classList.add('hidden');
            document.getElementById('modal-student-order-number').value = '';

            let uiClass, uiText;
            if (student.status === 'absent') { uiClass = 'bg-slate-200 text-slate-500 border-slate-300'; uiText = 'غائب'; }
            else if (student.status === 'pending') { uiClass = 'bg-slate-100 text-slate-500 border-slate-200'; uiText = 'قيد الانتظار'; }
            else {
                switch(student.final_level || student.level) {
                    case 'اللبنة 1': uiClass = 'bg-sky-100 text-sky-700 border-sky-200'; uiText = window.AppSettings.block1Name || 'اللبنة 1'; break;
                    case 'اللبنة 2': uiClass = 'bg-amber-100 text-amber-700 dark:text-amber-400 border-amber-200'; uiText = window.AppSettings.block2Name || 'اللبنة 2'; break;
                    case 'اللبنة 3': uiClass = 'bg-emerald-100 text-emerald-700 dark:text-emerald-400 border-emerald-200'; uiText = window.AppSettings.block3Name || 'اللبنة 3'; break;
                    default: uiClass = 'bg-slate-100 text-slate-600 border-slate-200'; uiText = 'مقيّم';
                }
            }
            
            document.getElementById('modal-assessment-status').innerHTML = `
                <span class="text-sm font-bold text-slate-600 dark:text-slate-300">حالة التقويم</span>
                <span class="text-xs font-bold px-3 py-1 rounded-md border ${uiClass}">${uiText}</span>
            `;
            
            document.getElementById('student-profile-modal').classList.remove('hidden');
        } catch(e) {
            console.error('Failed to open modal', e);
        }
    };

    window.handleModalClassChange = () => {
        const select = document.getElementById('modal-class-select');
        const container = document.getElementById('modal-order-number-container');
        if (parseInt(select.value) !== window.originalModalClassId) {
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
            document.getElementById('modal-student-order-number').value = '';
        }
    };

    window.saveStudentEdit = async () => {
        const id = document.getElementById('modal-student-id').value;
        const name = document.getElementById('modal-student-name').value;
        const massar = document.getElementById('modal-student-massar').value;
        const classId = document.getElementById('modal-class-select').value;
        const newOrderNum = document.getElementById('modal-student-order-number').value;
        
        let payload = { name, massar_id: massar, class_id: Number(classId) };
        if (newOrderNum && parseInt(classId) !== window.originalModalClassId) {
            payload.order_number = parseInt(newOrderNum);
        }
        
        try {
            await window.LocalDB.updateStudent(id, payload);
            
            document.getElementById('student-profile-modal').classList.add('hidden');
            
            if (window.activeRosterClassId && !document.getElementById('classes-screen').classList.contains('hidden')) {
                // We are inside the Student Management screen
                window.openClass(window.activeRosterClassId);
            } else if (window.currentClassId) {
                // We are inside the Assessment Space
                const quickSelect = document.getElementById('quick-class-select');
                if (parseInt(classId) !== window.currentClassId) {
                    window.currentClassId = parseInt(classId);
                    quickSelect.value = classId;
                }
                quickSelect.dispatchEvent(new Event('change'));
            }
        } catch (e) {
            await window.showCustomAlert('خطأ في حفظ التلميذ', e.message);
        }
    };

    window.deleteStudent = async (id) => {
        const isConfirmed = await window.showCustomConfirm(
            'تأكيد حذف التلميذ',
            'هل أنت متأكد من رغبتك في حذف هذا التلميذ نهائياً؟ لا يمكن التراجع عن هذا الإجراء.'
        );
        if (!isConfirmed) return;

        try {
            await window.LocalDB.deleteStudent(id);

            const profileModal = document.getElementById('student-profile-modal');
            if (profileModal) profileModal.classList.add('hidden');

            if (window.activeRosterClassId && !document.getElementById('classes-screen').classList.contains('hidden')) {
                window.openClass(window.activeRosterClassId);
            } else if (window.currentClassId) {
                const quickSelect = document.getElementById('quick-class-select');
                if (quickSelect) quickSelect.dispatchEvent(new Event('change'));
            }
        } catch (e) {
            await window.showCustomAlert('خطأ في الحذف', e.message);
        }
    };

    window.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            if (typeof window.initDashboard === 'function') window.initDashboard();
        }, 200);
    });

    // =========================================================================
    // PWA Install Prompt & Online/Offline Listener
    // =========================================================================
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        window.pwaDeferredPrompt = deferredPrompt;
        console.log('[PWA] Install prompt captured');
    });

    window.promptPWAInstall = async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log('[PWA] User response:', outcome);
            deferredPrompt = null;
        }
    };

    window.addEventListener('online', () => {
        console.log('[PWA] App is online');
    });

    window.addEventListener('offline', () => {
        console.log('[PWA] App is running offline from Service Worker cache');
    });
// --- Analytics SVG Hover Handlers ---
window.highlightAD = function(idx) {
    const data = window.analyticsDonutData;
    if (!data || !data[`seg_${idx}`]) return;
    
    document.querySelectorAll('.ad-seg').forEach((seg, i) => {
        seg.style.opacity = i === idx ? '1' : '0.25';
        seg.setAttribute('stroke-width', i === idx ? '16' : '12');
    });
    
    const centerVal = document.getElementById('ad-center-val');
    const centerLabel = document.getElementById('ad-center-label');
    
    if (centerVal && centerLabel) {
        gsap.to([centerVal, centerLabel], { opacity: 0, y: -4, duration: 0.15, onComplete: () => {
            centerVal.textContent = data[`seg_${idx}`].val;
            centerVal.style.color = data[`seg_${idx}`].color;
            centerLabel.textContent = `${data[`seg_${idx}`].label} (${data[`seg_${idx}`].sub})`;
            gsap.to([centerVal, centerLabel], { opacity: 1, y: 0, duration: 0.2 });
        }});
    }
};

window.resetAD = function() {
    document.querySelectorAll('.ad-seg').forEach(seg => { 
        seg.style.opacity = '1'; 
        seg.setAttribute('stroke-width', '12');
    });
    
    const centerVal = document.getElementById('ad-center-val');
    const centerLabel = document.getElementById('ad-center-label');
    const isDark = document.documentElement.classList.contains('dark');
    
    if (centerVal && centerLabel && window.analyticsDonutData) {
        gsap.to([centerVal, centerLabel], { opacity: 0, y: 4, duration: 0.15, onComplete: () => {
            centerVal.textContent = window.analyticsDonutData.total; 
            centerVal.style.color = isDark ? '#FFFFFF' : '#1E293B';
            centerLabel.textContent = 'إجمالي التلاميذ';
            gsap.to([centerVal, centerLabel], { opacity: 1, y: 0, duration: 0.2 });
        }});
    }
};

window.toggleAssessmentSidebar = function(show) {
    const sidebar = document.getElementById('assessment-sidebar');
    if (!sidebar) return;

    if (show) {
        const targetWidth = window.innerWidth >= 1024 ? '384px' : '320px';
        sidebar.style.width = targetWidth;
        sidebar.classList.remove('w-0', 'opacity-0');
        sidebar.classList.add('opacity-100');
    } else {
        sidebar.style.width = '0px';
        sidebar.classList.remove('opacity-100');
        sidebar.classList.add('w-0', 'opacity-0');
    }
};

// ============================================================================
// 6. Safe Debounced Resize Listener
// ============================================================================
(function() {
    let _sidebarResizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(_sidebarResizeTimer);
        _sidebarResizeTimer = setTimeout(() => {
            const sidebar = document.getElementById('assessment-sidebar');
            if (sidebar && !sidebar.classList.contains('w-0') && sidebar.style.width !== '0px' && sidebar.style.width !== '') {
                sidebar.style.width = window.innerWidth >= 1024 ? '384px' : '320px';
            }
        }, 150);
    });
})();

// Global touch listener to reset donut chart when tapping outside
document.addEventListener('touchstart', function(e) {
    const analyticsScreen = document.getElementById('analytics-screen');
    if (!analyticsScreen || analyticsScreen.classList.contains('hidden')) return;
    
    if (!e.target.closest('.ad-seg') && !e.target.closest('.bento-card')) {
        if (typeof window.resetAD === 'function') {
            window.resetAD();
        }
    }
});