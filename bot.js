"use strict";

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

function Shutdown(err) {
    console.error(err);
    process.exit(1);
}

if(!process.env.TOKEN)
    Shutdown('Необходим токен!');

const
    config = require('./config.json'),
    Util = require('./util.js'),
    Discord = require('discord.js'),
    Database = require('nedb-promise');

const client = new Discord.Client({
    messageCacheMaxSize: 1,
    disabledEvents: ['CHANNEL_PINS_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_UPDATE', 'USER_UPDATE', 'USER_NOTE_UPDATE', 'USER_SETTINGS_UPDATE', 'PRESENCE_UPDATE', 'VOICE_STATE_UPDATE', 'TYPING_START', 'VOICE_SERVER_UPDATE', 'RELATIONSHIP_ADD', 'RELATIONSHIP_REMOVE'],
});
client.on('disconnect', Shutdown);
client.on('error', () => console.warn('Connection error!'));
client.on('reconnecting', () => console.warn('Reconnecting...'));
client.on('resume', () => console.warn('Connection restored'));
client.on('rateLimit', () => console.warn('Rate limit!'));

const
    blacklistDb = new Database({ filename: './storage/users.db', autoload: true }),
    serversDb = new Database({ filename: './storage/servers.db', autoload: true });

const
    RemoveMentions = str => str.replace(Discord.MessageMentions.USERS_PATTERN, ''),
    GetMentions = str => str.match(Discord.MessageMentions.USERS_PATTERN),
    ServerToText = server => `\`${server.name}\` (${server.id})`,
    UserToText = user => `${user.toString()} (\`${user.tag}\`)`,
    UserNotExist = id => `пользователь с идентификатором \`${id}\` не существует.`,
    IsAdmin = member => member.hasPermission(Discord.Permissions.FLAGS.MANAGE_CHANNELS),
    IsModer = member => member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES);

const
    userHelp = `**Команды пользователя**
\`link\` - показать ссылку на приглашение бота.
\`help\` - показать данное справочное сообщение.`,
    
    moderHelp = `**Команды модератора**
\`cleanup N\` - удалить N последних сообщений на канале. За один раз можно удалить максимум 100 сообщений.
\`info @user\` - показать информацию об указанных пользователях из черного списка.
\`blacklist\` - показать список всех пользователей в черном списке.`,
    
    adminHelp = `**Команды администратора**
\`channel #канал\` - установка канала для информационных сообщений бота. Если канал не указан, параметр будет очищен.
\`stats\` - показать статистику.
\`serverlist\` - показать список всех подключенных к боту серверов.`,
    
    serviceHelp = `**Сервисные команды**
\`add @user причина\` - добавить указанных пользователей в черный список с указанием причины.
\`remove @user\` - убрать указанных пользователей из черного списка.
\`trust id\` - добавить сервер с указанным идентификатором в доверенные.
\`untrust id\` - убрать сервер с указанным идентификатором из доверенных.`;

const botCommands = {
    
    //Установка канала для информационных сообщений бота
    channel: async (message) => {
        if(!IsAdmin(message.member))
            return;
        
        const channel = message.mentions.channels.first();
        if(channel) {
            const perms = channel.permissionsFor(message.guild.me);
            if(!perms.has(Discord.Permissions.FLAGS.READ_MESSAGES)) {
                message.reply('нет права доступа к указанному каналу!');
                return;
            }
            if(!perms.has(Discord.Permissions.FLAGS.SEND_MESSAGES)) {
                message.reply('нет права на размещение сообщений в указанном канале!');
                return;
            }
            await serversDb.update({ _id: message.guild.id }, { $set: { channel: channel.id } }, { upsert: true });
            message.reply('канал установлен.');
        } else {
            await serversDb.update({ _id: message.guild.id }, { $unset: { channel: true } });
            message.reply('канал сброшен.');
        }
        
    },
    
    //Выдача информации о состоянии пользователя
    info: async (message) => {
        if(!IsModer(message.member))
            return;
        
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const user = await FetchUser(match[0]);
            if(!user) {
                message.reply(UserNotExist(match[0]));
                continue;
            }
            
            const userInfo = await blacklistDb.findOne({ _id: user.id });
            if(!userInfo) {
                message.channel.send(`**Информация**\nПользователь ${UserToText(user)} не находится в черном списке.`);
                continue;
            }
            
            const
                server = client.guilds.get(userInfo.server),
                moder = await FetchUser(userInfo.moder);
            
            message.channel.send(`**Информация**\nПользователь: ${UserToText(user)}\nСервер: ${server ? ServerToText(server) : userInfo.server}\nМодератор: ${moder ? UserToText(moder) : UserNotExist(moder)}\nДата добавления: ${Util.DtString(userInfo.date)}\nПричина: ${userInfo.reason}`);
        }
    },
    
    //Выдача списка всех пользователей в черном списке
    blacklist: async (message) => {
        if(!IsModer(message.member))
            return;
        
        const users = await blacklistDb.find({});
        
        await message.channel.send(`**Черный список**\nВсего пользователей: ${users.length}\n*Список будет подгружаться частями, это может занять некоторое время.*`);
        let text = '```py\n';
        for(let i = 0; i < users.length; i++) {
            const user = await FetchUser(users[i]._id);
            if(!user)
                continue;
            
            const add = `${user.toString()} → ${user.tag}\n`;
            if(text.length + add.length < 1990) {
                text += add;
            } else {
                await message.channel.send(text + '```');
                text = '```py\n' + add;
            }
        }
        await message.channel.send(text + '```');
    },
    
    //Удаление сообщений
    cleanup: async (message) => {
        if(!IsModer(message.member))
            return;
        
        const count = parseInt(message.content);
        if(count && (count > 0))
            message.channel.bulkDelete(Math.min(count, 100));
    },
    
    //Выдача статистики
    stats: async (message) => {
        if(!IsAdmin(message.member))
            return;
        
        const count = await blacklistDb.count({});
        message.channel.send(`**Статистика**\nПользователей в черном списке: ${count}\nПодключено серверов: ${client.guilds.size}`);
    },
    
    //Выдача списка всех подключенных серверов
    serverlist: async (message) => {
        if(!IsAdmin(message.member))
            return;
        
        const servers = [];
        for(const server of client.guilds.values()) {
            const info = await serversDb.findOne({ _id: server.id });
            servers.push({ connected: true, trusted: (info && info.trusted), id: server.id, name: server.name });
        }
        
        const serversFromDb = await serversDb.find({ trusted: true });
        for(let i = 0; i < serversFromDb.length; i++) {
            const server = serversFromDb[i];
            if(!client.guilds.has(server._id))
                servers.push({ connected: false, trusted: true, id: server._id, name: '' });
        }
        
        servers.sort((a, b) => (a.id > b.id) ? 1 : -1);
        
        let text = `**Список серверов**\nПодключено: ${client.guilds.size}\nВсего: ${servers.length}\n\`\`\`css\n`;
        for(let i = 0; i < servers.length; i++) {
            const
                server = servers[i],
                add = `${server.id} [${server.connected ? 'C' : ' '}${server.trusted ? 'T' : ' '}] ${server.name}\n`;
            
            if(text.length + add.length < 1990) {
                text += add;
            } else {
                await message.channel.send(text + '```');
                text = '```css\n' + add;
            }
        }
        text += '```';
        
        message.channel.send(text);
    },
    
    //Ссылка на приглашение бота
    link: async (message) => {
        message.reply(`<${await client.generateInvite(523334)}>`);
    },
    
    //Справка по боту
    help: async (message) => {
        let text = `**Справка**\n\n${userHelp}\n\n`;
        
        if(IsModer(message.member))
            text += `${moderHelp}\n\n`;
        
        if(IsAdmin(message.member))
            text += `${adminHelp}\n\n`;
        
        if((message.guild.id == config.mainServer) && IsAdmin(message.member))
            text += `${serviceHelp}\n\n`;
        
        message.channel.send(text);
    },
    
    //Суперадминские команды, работают только на главном сервере
    //Добавление в черный список
    add: async (message) => {
        if(!((message.guild.id == config.mainServer) && IsAdmin(message.member)))
            return;
        
        //Реализуем через ручной поиск упоминаний юзеров, так как пользователь может быть не на сервере.
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        const
            reason = RemoveMentions(message.content).trim(),
            dt = Date.now();
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const user = await FetchUser(match[0]);
            if(!user) {
                message.reply(UserNotExist(match[0]));
                continue;
            }
            
            if(user.id == client.user.id) {
                message.reply(':(');
                continue;
            }
            
            SpreadBan(user.id, true, reason);
            
            await blacklistDb.update({ _id: user.id }, { $set: { server: message.guild.id, moder: message.author.id, date: dt, reason: reason } }, { upsert: true });
            message.reply(`пользователь ${UserToText(user)} добавлен в черный список.`);
        }
    },
    
    //Удаление из черного списка
    remove: async (message) => {
        if(!((message.guild.id == config.mainServer) && IsAdmin(message.member)))
            return;
        
        //Реализуем через ручной поиск упоминаний юзеров, так как пользователь может быть не на сервере.
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const user = await FetchUser(match[0]);
            if(!user) {
                message.reply(UserNotExist(match[0]));
                continue;
            }
            
            await blacklistDb.remove({ _id: user.id });
            SpreadBan(user.id, false);
            message.reply(`пользователь ${UserToText(user)} удален из черного списка.`);
        }
    },
    
    //Добавление доверенного сервера
    trust: async (message) => {
        if(!((message.guild.id == config.mainServer) && IsAdmin(message.member)))
            return;
        
        const match = message.content.match(/[0-9]+/);
        if(!match)
            return;
        
        const
            id = match[0],
            server = client.guilds.get(id);
        
        await serversDb.update({ _id: id }, { $set: { trusted: true } }, { upsert: true });
        message.reply(`${server ? `сервер ${ServerToText(server)}` : `идентификатор \`${id}\``} добавлен в список доверенных.`);
    },
    
    //Удаление доверенного сервера
    untrust: async (message) => {
        if(!((message.guild.id == config.mainServer) && IsAdmin(message.member)))
            return;
        
        const match = message.content.match(/[0-9]+/);
        if(!match)
            return;
        
        const
            id = match[0],
            server = client.guilds.get(id);
        
        await serversDb.update({ _id: id }, { $unset: { trusted: true } });
        message.reply(`${server ? `сервер ${ServerToText(server)}` : `идентификатор \`${id}\``} удален из списка доверенных.`);
    },
    
};

//Проверка пользователя в черном списке
async function CheckBanned(member) {
    //Не трогаем админсостав
    if(IsModer(member))
        return false;
    
    const userInfo = await blacklistDb.findOne({ _id: member.id });
    if(!userInfo)
        return false;
    
    const
        server = member.guild,
        user = member.user;
    
    try {
        await member.ban({ days: 1, reason: userInfo.reason });
    } catch {
        Notify(server, `Не удалось выдать бан пользователю из черного списка ${UserToText(user)}! У бота недостаточно прав, либо роль пользователя находится выше роли бота.`);
        return true;
    }
    
    Notify(server, `Пользователю ${UserToText(user)} из черного списка выдан автоматический бан!\nУказанная причина: ${userInfo.reason}`);
    return true;
}

const suspiciousUsers = new Map();
//Проверка сообщения на спам инвайтами
async function CheckSpam(message) {
    //Не трогаем админсостав
    if(IsModer(message.member))
        return false;
    
    const codes = Util.GetInviteCodes(message.content);
    if(!codes.length)
        return false;
    
    let white = 0;
    for(let i = 0; i < codes.length; i++) {
        const invite = await GetInvite(codes[i]);
        if(!invite)
            break;
        
        if(invite.guild.id == message.guild.id) {
            white++;
            continue;
        }
        
        const info = await serversDb.findOne({ _id: invite.guild.id });
        if(info && info.trusted) {
            white++;
            continue;
        }
        
        break;
    }
    
    if(white == codes.length)
        return false;
    
    const now = Date.now();
    let resident = false;
    if(message.member.joinedTimestamp < now - config.banJoinPeriod) {
        resident = true;
    } else {
        for(const server of client.guilds.values()) {
            if(server.id == message.guild.id)
                continue;
            
            const member = await FetchMember(server, message.author.id);
            if(member && (member.joinedTimestamp < now - config.banJoinPeriod)) {
                resident = true;
                break;
            }
        }
    }
    
    const
        server = message.guild,
        user = message.author;
    
    if(resident) {
        if(suspiciousUsers.has(user.id)) {
            await message.delete();
            user.send(`Обнаружено злоупотребление инвайтами. Сообщение удалено.`);
            Notify(server, `Злоупотребление инвайтами от пользователя ${UserToText(user)}. Сообщение удалено, пользователю выслано предупреждение.\n\n**Содержимое сообщения**\n${message.content}`);
            clearTimeout(suspiciousUsers.get(user.id));
        }
        suspiciousUsers.set(user.id, setTimeout(suspiciousUsers.delete, config.suspiciousTimeout, user.id));
    } else {
        if(suspiciousUsers.has(user.id)) {
            await blacklistDb.insert({ _id: user.id, server: server.id, moder: client.user.id, date: Date.now(), reason: 'Автоматически: сторонний пользователь, спам сторонним инвайтом' });
            Notify(server, `Пользователь ${UserToText(user)} автоматически добавлен в черный список.\n\n**Содержимое сообщения**\n${message.content}`);
            try {
                await message.member.ban({ days: 1, reason: 'Автоматический бан' });
            } catch {
                Notify(server, `Не удалось забанить пользователя ${UserToText(user)} на сервере! У бота недостаточно прав, либо роль пользователя находится выше роли бота.`);
            }
            suspiciousUsers.delete(user.id);
        } else {
            await message.delete();
            suspiciousUsers.set(user.id, 0);
            user.send(`Обнаружена попытка спама на сервере ${ServerToText(server)}. Сообщение удалено. Повторная попытка спама приведет к бану.`);
            Notify(server, `Сторонний пользователь ${UserToText(user)} разместил стороннее приглашение. Сообщение удалено, пользователю выслано предупреждение. Повторная попытка приведет к бану.\n\n**Содержимое сообщения**\`\`\`${message.content}\`\`\``);
        }
    }
    
    return true;
}

//Попытка забанить/разбанить пользователя на всех подключенных серверах
async function SpreadBan(userId, mode, reason) {
    for(const server of client.guilds.values()) {
        if(mode) {
            try {
                await server.ban(userId, reason);
            } catch {
                ServiceLog(`Не удалось забанить пользователя ${UserToText(user)} на сервере ${ServerToText(server)}! У бота недостаточно прав, либо роль пользователя находится выше роли бота.`);
            }
        } else {
            try {
                await server.unban(userId);
            } catch {}
        }
    }
}

async function SendInfo(server, msg) {
    const info = await serversDb.findOne({ _id: server.id });
    if(info && info.channel) {
        const channel = client.channels.get(info.channel);
        if(channel)
            channel.send(msg);
    }
}

async function ServiceLog(msg) {
    client.channels.get(config.serviceChannel).send(msg);
}

async function Notify(server, msg) {
    SendInfo(server, msg);
    ServiceLog(`**Сервер:** ${ServerToText(server)}\n**Событие:**\n${msg}`);
}

async function FetchUser(id) {
    try {
        return await client.fetchUser(id, false);
    } catch {}
}

async function FetchMember(server, id) {
    try {
        return await server.fetchMember(id, false);
    } catch {}
}

async function GetInvite(code) {
    try {
        return await client.rest.methods.getInvite(code);
    } catch {}
}

client.on('guildMemberAdd', CheckBanned);

client.on('guildCreate', async (server) => {
    ServiceLog(`**Подключен новый сервер!**\n${ServerToText(server)}\nВладелец: ${UserToText(server.owner.user)}`);
});
client.on('guildDelete', async (server) => {
    ServiceLog(`**Сервер отключен**\n${ServerToText(server)}`);
});

client.on('message', async (message) => {
    if(!(message.content && message.member))
        return;
    
    if(message.author.id == client.user.id)
        return;
    
    if(await CheckBanned(message.member))
        return;
    
    if(await CheckSpam(message))
        return;
    
    if(!message.content.startsWith(config.prefix))
        return;
    
    const
        si = message.content.indexOf(' '),
        command = botCommands[message.content.substring(config.prefix.length, (si > 0) ? si : undefined).toLowerCase()];
    
    if(command) {
        message.content = message.content.substring((si > 0) ? (si + 1) : '');
        command(message);
    }
});

client.on('ready', async () => {
    console.log('READY');
    client.user.setPresence({ game: { name: `${config.prefix}help`, type: 'WATCHING' } });
    
    //Очистка пустых записей в базе серверов
    serversDb.remove({ trusted: { $exists: false }, channel: { $exists: false } }, { multi: true });
});

client.login(process.env.TOKEN);
