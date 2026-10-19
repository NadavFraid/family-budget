'use strict';

// צפי החזר הלוואות: מתי יגיע כל תשלום שנותר ובאיזה סכום.
//
// הנחות (מוצגות למשתמש באתר):
//  1. התשלומים שנותרו יורדים אחד לחודש, ברצף. התשלום הבא הוא בחודש הנוכחי (startOffset = 0)
//     או בחודש הבא (startOffset = 1), כי האתר לא יודע אם התשלום של החודש כבר סומן כשולם.
//  2. כל תשלום שווה לתשלום החודשי שהוזן. בהלוואה בלי תשלום חודשי: קרן ÷ מספר התשלומים
//     הכולל (בלי ריבית), והיא מסומנת כהערכה.
//
// הסכומים מחושבים באגורות שלמות, כדי שסכום ההלוואות לא יסטה בגלל שברים.

const MAX_MONTHS = 700;

function addMonths(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const index = y * 12 + (m - 1) + n;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
}

const toAgorot = value => Math.round(value * 100);
const fromAgorot = value => value / 100;

/**
 * @param {Array<{id:number, lender:string, principal:number, total_payments:number, paid_payments:number, monthly_payment:number|null}>} loans
 * @param {{currentMonth: string, startOffset?: 0|1}} options  currentMonth בפורמט YYYY-MM
 */
function buildLoanForecast(loans, { currentMonth, startOffset = 0 }) {
    const firstMonth = addMonths(currentMonth, startOffset);
    const active = (loans || [])
        .filter(l => l.total_payments > l.paid_payments)
        .map(l => {
            const estimated = !l.monthly_payment;
            const payment = estimated ? toAgorot(l.principal / l.total_payments) : toAgorot(l.monthly_payment);
            const remaining = Math.min(l.total_payments - l.paid_payments, MAX_MONTHS);
            return { loan: l, estimated, payment, remaining };
        });

    if (active.length === 0) {
        return { startMonth: firstMonth, months: [], totals: [], loans: [], steps: [], summary: null };
    }

    const lastPaymentIndex = Math.max(...active.map(a => a.remaining)) - 1;
    // חודש נוסף בסוף עם 0, כדי שהגרף יראה את ההחזר מגיע לאפס
    const monthCount = lastPaymentIndex + 2;
    const months = Array.from({ length: monthCount }, (_, i) => addMonths(firstMonth, i));

    const loanSeries = active.map(a => ({
        id: a.loan.id,
        lender: a.loan.lender,
        estimated: a.estimated,
        remaining: a.remaining,
        payment: fromAgorot(a.payment),
        endMonth: addMonths(firstMonth, a.remaining - 1),
        amounts: months.map((_, i) => (i < a.remaining ? fromAgorot(a.payment) : 0))
    }));

    const totalsAgorot = months.map((_, i) => active.reduce((sum, a) => sum + (i < a.remaining ? a.payment : 0), 0));
    const totals = totalsAgorot.map(fromAgorot);

    // תקופות עם החזר חודשי קבוע (בלי חודש האפס שבסוף)
    const steps = [];
    for (let i = 0; i < monthCount - 1; i += 1) {
        const last = steps[steps.length - 1];
        if (last && last.amount === totals[i]) last.to = months[i];
        else steps.push({ from: months[i], to: months[i], amount: totals[i] });
    }

    const dropIndex = totals.findIndex((t, i) => i > 0 && t < totals[i - 1]);
    const remainingAgorot = active.reduce((sum, a) => sum + a.payment * a.remaining, 0);
    const estimatedLoans = active.filter(a => a.estimated);

    return {
        startMonth: firstMonth,
        months,
        totals,
        loans: loanSeries,
        steps,
        summary: {
            currentMonthly: totals[0],
            remainingTotal: fromAgorot(remainingAgorot),
            lastPaymentMonth: months[monthCount - 2],
            monthsLeft: monthCount - 1,
            // הירידה הקרובה בהחזר החודשי (הירידה האחרונה היא ל-0, אחרי התשלום האחרון)
            nextDrop: dropIndex === -1 ? null : { month: months[dropIndex], amount: totals[dropIndex], from: totals[dropIndex - 1] },
            estimatedCount: estimatedLoans.length,
            estimatedLenders: estimatedLoans.map(a => a.loan.lender)
        }
    };
}

module.exports = { buildLoanForecast, addMonths };
