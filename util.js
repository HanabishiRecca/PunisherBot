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
        regExp = /discord(?:app\s*\.\s*com\s*\/\s*invite|\s*\.\s*gg(?:\s*\/\s*invite)?)\s*\/\s*([\w-]{2,255})/ig;
    
    let match;
    while(match = regExp.exec(str))
        if(match.length > 1)
            result.push(match[1]);
    
    return result;
}

exports.GetNewsTags = (str) => {
    const
        result = [],
        regExp = /\$(\w+)/ig;
    
    let match;
    while(match = regExp.exec(str))
        if(match.length > 1)
            result.push(match[1]);
    
    return result;
}

exports.GetFirstNewsTag = (str) => {
    const match = str.match(/\$(\w+)/i);
    if(match)
        return match[1];
}

exports.ParseJSON = (text) => {
    try {
        return JSON.parse(text);
    } catch {}
}

exports.ReplaceApostrophe = (text) => text.replace(/'/g, '’');
