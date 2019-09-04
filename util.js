'use strict';

exports.GetFirstUserMention = str => {
    const match = str.match(/<@!?([0-9]+)>/);
    if(match)
        return match[1];
};

exports.RemoveMentions = str => str.replace(/<@!?[0-9]+>/g, '');

exports.GetFirstChannelMention = str => {
    const match = str.match(/<#([0-9]+)>/);
    if(match)
        return match[1];
};

exports.GetInviteCodes = str => {
    const
        result = [],
        regExp = /discord(?:app\s*\.\s*com\s*\/\s*invite|\s*\.\s*gg(?:\s*\/\s*invite)?)\s*\/\s*([\w-]{2,255})/ig;
    
    let match;
    while(match = regExp.exec(str))
        if(match.length > 1)
            result.push(match[1]);
    
    return result;
}

exports.GetNewsTags = str => {
    const
        result = [],
        regExp = /\$(\w+)/ig;
    
    let match;
    while(match = regExp.exec(str))
        if(match.length > 1)
            result.push(match[1]);
    
    return result;
}

exports.GetFirstNewsTag = str => {
    const match = str.match(/\$(\w+)/i);
    if(match)
        return match[1];
}

exports.ParseJSON = (text) => {
    try {
        return JSON.parse(text);
    } catch {}
}

exports.ReplaceApostrophe = text => text.replace(/'/g, '’');
