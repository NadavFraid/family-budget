'use strict';

const fs = require('fs');
const path = require('path');

const BACKUP_PREFIX = 'budget-';
const BACKUP_SUFFIX = '.db';
const BACKUP_NAME_PATTERN = /^budget-\d{4}-\d{2}-\d{2}\.db$/;
const DEFAULT_KEEP = 14;

function backupFileName(dateStr) {
    return `${BACKUP_PREFIX}${dateStr}${BACKUP_SUFFIX}`;
}

// גיבויים קיימים (רק קבצים בשם הצפוי), מהחדש לישן
function listBackups(backupDir) {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
        .filter(name => BACKUP_NAME_PATTERN.test(name))
        .sort()
        .reverse()
        .map(name => {
            const stat = fs.statSync(path.join(backupDir, name));
            return { name, size: stat.size, modified: stat.mtime.toISOString() };
        });
}

// משאיר את `keep` הגיבויים האחרונים ומוחק את השאר. לא נוגע בקבצים אחרים בתיקייה.
function pruneBackups(backupDir, keep = DEFAULT_KEEP) {
    const removed = [];
    for (const backup of listBackups(backupDir).slice(keep)) {
        fs.unlinkSync(path.join(backupDir, backup.name));
        removed.push(backup.name);
    }
    return removed;
}

/**
 * יוצר גיבוי מלא של היום בתיקיית הגיבויים (מחליף גיבוי קודם של אותו יום) ומנקה גיבויים ישנים.
 * `snapshot(destPath)` מקבל נתיב שלא קיים ויוצר עליו עותק עקבי של מסד הנתונים.
 * הכתיבה לקובץ זמני ואז שינוי שם: כשל באמצע לא משאיר גיבוי חלקי תחת שם תקין.
 */
async function createDailyBackup({ backupDir, dateStr, snapshot, keep = DEFAULT_KEEP }) {
    fs.mkdirSync(backupDir, { recursive: true });
    const finalPath = path.join(backupDir, backupFileName(dateStr));
    const tmpPath = `${finalPath}.tmp`;
    fs.rmSync(tmpPath, { force: true });
    try {
        await snapshot(tmpPath);
        fs.renameSync(tmpPath, finalPath);
    } catch (err) {
        fs.rmSync(tmpPath, { force: true });
        throw err;
    }
    const removed = pruneBackups(backupDir, keep);
    return { path: finalPath, name: backupFileName(dateStr), size: fs.statSync(finalPath).size, removed };
}

module.exports = { backupFileName, listBackups, pruneBackups, createDailyBackup, DEFAULT_KEEP };
