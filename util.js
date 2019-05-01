const Intl = require('intl');

(() => {
    const formatter = new Intl.DateTimeFormat('ru', {
        timeZone: 'UTC',
        hour12: false,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
    exports.DtString = dt => `${formatter.format(new Date(dt))} UTC`;
})();
