"use strict";

const Intl = require('intl');

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

exports.GetInviteCodes = (str) => {
    const
        result = [],
        regExp = /discord(?:app\s*\.\s*com\/invite|\s*\.\s*gg(?:\/invite)?)\/([\w-]{2,255})/ig;
    
    let match;
    while(match = regExp.exec(str))
        if(match.length > 1)
            result.push(match[1]);
    
    return result;
}
