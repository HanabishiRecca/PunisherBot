"use strict";

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

function Shutdown(err) {
    console.error(err);
    process.exit(1);
}

if(!process.env.TOKEN)
    Shutdown('Необходим токен!');

const storagePath = process.env.STORAGE;
if(!storagePath)
    Shutdown('Необходим путь к хранилищу!');

const
    config = require('./config.json'),
    Util = require('./util.js'),
    Discord = require('discord.js'),
    Database = require('nedb-promise'),
    fs = require('fs');

const client = new Discord.Client({
    messageCacheMaxSize: 1,
    disabledEvents: ['CHANNEL_PINS_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_UPDATE', 'PRESENCE_UPDATE', 'VOICE_STATE_UPDATE', 'TYPING_START', 'VOICE_SERVER_UPDATE', 'RELATIONSHIP_ADD', 'RELATIONSHIP_REMOVE'],
});
client.on('disconnect', Shutdown);
client.on('error', () => console.warn('Connection error!'));
client.on('reconnecting', () => console.warn('Reconnecting...'));
client.on('resume', () => console.warn('Connection restored'));
client.on('rateLimit', () => console.warn('Rate limit!'));

const
    blacklistDb = new Database({ filename: `${storagePath}/blacklist.db`, autoload: true }),
    serversDb = new Database({ filename: `${storagePath}/servers.db`, autoload: true }),
    categoriesDb = new Database({ filename: `${storagePath}/categories.db`, autoload: true }),
    hooksDb = new Database({ filename: `${storagePath}/hooks.db`, autoload: true });

const
    RemoveMentions = str => str.replace(Discord.MessageMentions.USERS_PATTERN, ''),
    GetMentions = str => str.match(Discord.MessageMentions.USERS_PATTERN),
    ServerToText = server => `\`${server.name}\` (${server.id})`,
    UserToText = user => `${user.toString()} (\`${user.tag}\`)`,
    UserNotExist = id => `пользователь с идентификатором \`${id}\` не существует.`,
    CatNotExist = tag => `категория \`${tag}\` не существует.`,
    MessageContent = str => `**Содержимое сообщения**\`\`\`${str}\`\`\``,
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
\`serverlist\` - показать список всех подключенных к боту серверов.
\`subscribe $tag\` - подписаться на категории с указанными тегами. Если теги не указаны, будет осуществлена подписка на все категории.
\`tags\` - показать список всех доступных новостных категорий.`,
    
    serviceHelp = `**Сервисные команды**
\`add @user причина\` - добавить указанных пользователей в черный список с указанием причины.
\`remove @user\` - убрать указанных пользователей из черного списка.
\`trust id\` - добавить сервер с указанным идентификатором в доверенные.
\`untrust id\` - убрать сервер с указанным идентификатором из доверенных.
\`post $tag {...}\` - разместить новость в указанную категорию с указанным телом сообщения (JSON). Конструктор тела сообщения: <https://leovoel.github.io/embed-visualizer/>
\`hooks\` - показать список всех активных подписок (вебхуков).
\`addcat {...}\` - добавить категорию с указанными параметрами. Параметры представляют из себя объект JSON с полями tag, name и avatar.
\`removecat $tag\` - удалить категорию с указанным тегом.
\`dumpcat $tag\` - показать информацию о категории с указанным тегом.`;

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
        
        let text = '**Черный список**\n```cs\n';
        
        const bans = (await client.guilds.get(config.mainServer).fetchBans(true)).array();
        for(let i = 0; i < bans.length; i++) {
            const
                banInfo = bans[i],
                userInfo = await blacklistDb.findOne({ _id: banInfo.user.id });
            
            if(!userInfo)
                continue;
            
            const add = `${banInfo.user.id} → ${Util.ReplaceApostrophe(banInfo.user.username)}#${banInfo.user.discriminator}\n`;
            if(text.length + add.length < 1990) {
                text += add;
            } else {
                await message.channel.send(text + '```');
                text = '```cs\n' + add;
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
            const serverInfo = await serversDb.findOne({ _id: server.id });
            servers.push({ connected: true, trusted: (serverInfo && serverInfo.trusted), id: server.id, name: server.name });
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
        message.reply(`<${await client.generateInvite(537394246)}>`);
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
            
            SpreadBan(user, true, reason);
            
            await blacklistDb.update({ _id: user.id }, { $set: { server: message.guild.id, moder: message.author.id, date: dt, reason: reason } }, { upsert: true });
            message.reply(`пользователь ${UserToText(user)} добавлен в черный список.`);
        }
        
        PushBlacklist();
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
            SpreadBan(user, false);
            message.reply(`пользователь ${UserToText(user)} удален из черного списка.`);
        }
        
        PushBlacklist();
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
        
        PushServerList();
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
        
        PushServerList();
    },
    
    subscribe: async (message) => {
        if(!IsAdmin(message.member))
            return;
        
        const
            match = Util.GetNewsTags(message.content),
            tags = [];
        
        for(let i = 0; i < match.length; i++) {
            const
                tag = match[i].toLowerCase(),
                cat = await categoriesDb.findOne({ _id: tag });
            
            if(cat) {
                tags.push(tag);
            } else {
                message.reply(CatNotExist(tag));
                return;
            }
        }
        
        const
            name = `Новости (${tags.length ? tags.join(', ') : 'все'})`,
            webhook = await CreateWebhook(message.channel, name);
        
        if(!webhook) {
            message.reply('не удалось создать вебхук.');
            return;
        }
        
        await hooksDb.insert({ _id: webhook.id, token: webhook.token, tags: (tags.length ? tags : undefined) });
        message.reply(`в текущем канале создана подписка на \`${name}\`.`);
    },
    
    post: async (message) => {
        if(!((message.guild.id == config.mainServer) && IsAdmin(message.member)))
            return;
        
        const jsonIndex = message.content.indexOf('{');
        if(jsonIndex < 0) {
            message.reply('в сообщении не найден JSON.');
            return;
        }
        
        const obj = Util.ParseJSON(message.content.substring(jsonIndex));
        if(!obj) {
            message.reply('некорректный JSON.');
            return;
        }
        
        try {
            await message.channel.send(obj.content || '', { embed: obj.embed });
        } catch {
            message.reply('не удалось отправить проверочное сообщение.');
            return;
        }
        
        const match = Util.GetFirstNewsTag(message.content);
        if(!match)
            return;
        
        const
            tag = match.toLowerCase(),
            cat = await categoriesDb.findOne({ _id: tag });
        
        if(!cat) {
            message.reply(CatNotExist(tag));
            return;
        }
        
        SendNews(tag, obj.content, obj.embed);
    },
    
    tags: async (message) => {
        if(!IsAdmin(message.member))
            return;
        
        let text = '**Список категорий**\n\n';
        const categories = await categoriesDb.find({});
        
        for(let i = 0; i < categories.length; i++) {
            const cat = categories[i];
            text += `\`${cat._id}\` - ${cat.name || client.user.username}\n`;
        }
        
        message.channel.send(text);
    },
    
    hooks: async (message) => {
        if(!((message.guild.id == config.mainServer) && IsAdmin(message.member)))
            return;
        
        const hooks = await hooksDb.find({});
        let text = `**Активные подписки**\n\n`;
        for(let i = 0; i < hooks.length; i++) {
            const
                hookInfo = hooks[i],
                hook = await GetWebhook(hookInfo._id, hookInfo.token);
            
            if(!hook) {
                await hooksDb.remove(hookInfo);
                continue;
            }
            
            const
                server = client.guilds.get(hook.guild_id),
                add = `${server ? ServerToText(server) : hook.guild_id} | ${hookInfo.tags ? `[${hookInfo.tags.join(', ')}]` : 'все категории' }\n`;
            
            if(text.length + add.length < 1990) {
                text += add;
            } else {
                await message.channel.send(text);
                text = add;
            }
        }
        await message.channel.send(text);
    },
    
    addcat: async (message) => {
        if(!((message.guild.id == config.mainServer) && IsAdmin(message.member)))
            return;
        
        const jsonIndex = message.content.indexOf('{');
        if(jsonIndex < 0) {
            message.reply('в сообщении не найден JSON.');
            return;
        }
        
        const obj = Util.ParseJSON(message.content.substring(jsonIndex));
        if(!obj) {
            message.reply('некорректный JSON.');
            return;
        }
        
        if(typeof(obj.tag) != 'string') {
            message.reply('необходимо указать тег категории.');
            return;
        }
        
        const data = {};
        if(typeof(obj.name) == 'string')
            data.name = obj.name;
        
        if(typeof(obj.avatar) == 'string')
            data.avatar = obj.avatar;
        
        await categoriesDb.update({ _id: obj.tag }, { $set: data }, { upsert: true });
        
        message.reply(`категория \`${obj.tag}\` добавлена.`);
    },
    
    removecat: async (message) => {
        if(!((message.guild.id == config.mainServer) && IsAdmin(message.member)))
            return;
        
        const match = Util.GetFirstNewsTag(message.content);
        if(!match) {
            message.reply('необходимо указать категорию для удаления.');
            return;
        }
        
        const
            tag = match.toLowerCase(),
            cat = await categoriesDb.findOne({ _id: tag });
        
        if(!cat) {
            message.reply(CatNotExist(tag));
            return;
        }
        
        await categoriesDb.remove({ _id: tag });
        
        message.reply(`категория \`${tag}\` удалена.`);
    },
    
    dumpcat: async (message) => {
        if(!((message.guild.id == config.mainServer) && IsAdmin(message.member)))
            return;
        
        const match = Util.GetFirstNewsTag(message.content);
        if(!match) {
            message.reply('необходимо указать категорию .');
            return;
        }
        
        const
            tag = match.toLowerCase(),
            cat = await categoriesDb.findOne({ _id: tag });
        
        if(!cat) {
            message.reply(CatNotExist(tag));
            return;
        }
        
        const obj = { tag };
        if(cat.name)
            obj.name = cat.name;
        
        if(cat.avatar)
            obj.avatar = cat.avatar;
        
        message.channel.send(JSON.stringify(obj, null, 4));
    },
};

async function SendNews(tag, content, embed) {
    const
        channels = new Set(),
        hooks = await hooksDb.find({});
    
    hooks.forEach(async (hookInfo) => {
        const hook = await GetWebhook(hookInfo._id, hookInfo.token);
        if(!hook) {
            await hooksDb.remove(hookInfo);
            return;
        }
        
        if(channels.has(hook.channel_id))
            return;
        
        if(hookInfo.tags && hookInfo.tags.length && (hookInfo.tags.indexOf(tag) < 0))
            return;
        
        const cat = await categoriesDb.findOne({ _id: tag });
        if(!cat)
            return;
        
        SendWebhookMessage(hookInfo._id, hookInfo.token, cat.name || client.user.username, cat.avatar || client.user.avatarURL, content || '', embed);
        channels.add(hook.channel_id);
    });
}

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
    
    if(await TryBan(server, user, userInfo.reason))
        Notify(server, `Пользователю ${UserToText(user)} из черного списка выдан автоматический бан!\nУказанная причина: ${userInfo.reason}`);
    
    return true;
}

const suspiciousUsers = new Map();
//Проверка сообщения на спам инвайтами
async function CheckSpam(message) {
    //Не трогаем ботов
    if(message.author.bot)
        return false;
    
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
        
        const serverInfo = await serversDb.findOne({ _id: invite.guild.id });
        if(serverInfo && serverInfo.trusted) {
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
            Notify(server, `Злоупотребление инвайтами от пользователя ${UserToText(user)}.\n\n${MessageContent(message.content)}`);
            clearTimeout(suspiciousUsers.get(user.id));
            TryDelete(server, message);
            TrySendToUser(user, `Обнаружено злоупотребление инвайтами.`);
        }
        suspiciousUsers.set(user.id, setTimeout(() => suspiciousUsers.delete(user.id), config.suspiciousTimeout));
    } else {
        if(suspiciousUsers.has(user.id)) {
            await blacklistDb.insert({ _id: user.id, server: server.id, moder: client.user.id, date: Date.now(), reason: 'Автоматически: сторонний пользователь, спам сторонним инвайтом' });
            Notify(server, `Пользователь ${UserToText(user)} автоматически добавлен в черный список по причине спама.\n\n${MessageContent(message.content)}`);
            if(await TryBan(server, user, 'Автоматический бан'))
                suspiciousUsers.delete(user.id);
            else
                TryDelete(server, message);
            
            await TryBan(client.guilds.get(config.mainServer), user, 'Автоматический бан');
            PushBlacklist();
        } else {
            suspiciousUsers.set(user.id, 0);
            Notify(server, `Сторонний пользователь ${UserToText(user)} разместил стороннее приглашение. Повторная попытка приведет к бану.\n\n${MessageContent(message.content)}`);
            TryDelete(server, message);
            TrySendToUser(user, `Обнаружена попытка спама на сервере ${ServerToText(server)}. Повторная попытка спама приведет к бану.`);
        }
    }
    
    return true;
}

//Попытка забанить/разбанить пользователя на всех подключенных серверах
async function SpreadBan(user, mode, reason) {
    for(const server of client.guilds.values())
        if(mode)
            TryBan(server, user, reason);
        else
            TryUnban(server, user);
}

async function SendInfo(server, msg) {
    const serverInfo = await serversDb.findOne({ _id: server.id });
    if(serverInfo && serverInfo.channel) {
        const channel = client.channels.get(serverInfo.channel);
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

async function TryDelete(server, message) {
    try {
        await message.delete();
    } catch {
        Notify(server, `**Не удалось удалить сообщение!**\nСсылка: ${message.url}`);
        return false;
    }
    return true;
}

async function TrySendToUser(user, message) {
    try {
        await user.send(message);
    } catch {
        return false;
    }
    return true;
}

async function TryBan(server, user, reason) {
    try {
        await server.ban(user, { days: 1, reason });
    } catch {
        Notify(server, `Не удалось забанить пользователя ${UserToText(user)}!`);
        return false;
    }
    return true;
}

async function TryUnban(server, user) {
    try {
        await server.unban(user);
    } catch {
        Notify(server, `Не удалось разбанить пользователя ${UserToText(user)}!`);
        return false;
    }
    return true;
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

async function CreateWebhook(channel, name, avatar) {
    try {
        return await client.rest.makeRequest('post', Discord.Constants.Endpoints.Channel(channel).webhooks, true, { name, avatar });
    } catch {}
}

async function GetWebhook(id, token) {
    try {
        return await client.rest.makeRequest('get', Discord.Constants.Endpoints.Webhook(id, token));
    } catch {}
}

async function SendWebhookMessage(id, token, username, avatar_url, content, embed) {
    await client.rest.makeRequest('post', Discord.Constants.Endpoints.Webhook(id, token), false, { username, avatar_url, content, embeds: embed ? [embed] : undefined });
}

async function PushServerList() {
    if(!process.env.WEB_DIR)
        return;
    
    const
        servers = client.guilds.array(),
        output = [];
    
    for(let i = 0; i < servers.length; i++) {
        const
            server = servers[i],
            serverInfo = await serversDb.findOne({ _id: server.id });
        
        output.push({
            id: server.id,
            name: server.name,
            users: server.memberCount,
            image: server.icon,
            trusted: serverInfo ? serverInfo.trusted : false,
        });
    }
    
    fs.writeFileSync(`${process.env.WEB_DIR}/servers.json`, JSON.stringify(output));
}

async function PushBlacklist() {
    if(!process.env.WEB_DIR)
        return;
    
    const
        bans = (await client.guilds.get(config.mainServer).fetchBans(true)).array(),
        output = [];
    
    for(let i = 0; i < bans.length; i++) {
        const
            banInfo = bans[i],
            userInfo = await blacklistDb.findOne({ _id: banInfo.user.id });
        
        if(!userInfo)
            continue;
        
        output.push({
            id: banInfo.user.id,
            username: banInfo.user.username,
            discriminator: banInfo.user.discriminator,
            avatar: banInfo.user.avatar,
            reason: userInfo.reason,
        });
    }
    
    fs.writeFileSync(`${process.env.WEB_DIR}/blacklist.json`, JSON.stringify(output));
}

client.on('guildMemberAdd', async (member) => {
    CheckBanned(member);
    PushServerList();
});

client.on('guildMemberRemove', async () => {
    PushServerList();
});

client.on('guildCreate', async (server) => {
    ServiceLog(`**Подключен новый сервер!**\n${ServerToText(server)}\nВладелец: ${UserToText(server.owner.user)}`);
    PushServerList();
});

client.on('guildDelete', async (server) => {
    ServiceLog(`**Сервер отключен**\n${ServerToText(server)}`);
    PushServerList();
});

client.on('guildUpdate', async () => {
    PushServerList();
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
        si = message.content.search(/(\s|\n|$)/),
        command = botCommands[message.content.substring(config.prefix.length, (si > 0) ? si : undefined).toLowerCase()];
    
    if(command) {
        message.content = message.content.substring((si > 0) ? (si + 1) : '');
        command(message);
    }
});

client.on('ready', async () => {
    console.log('READY');
    client.user.setPresence({ game: { name: `${config.prefix}help`, type: 'WATCHING' } });
    
    require('http').createServer((_, res) => res.end('ONLINE')).listen(21240);
    
    PushServerList();
    PushBlacklist();
    
    client.setInterval(() => {
        PushBlacklist();
    }, 3600000);
});

client.login(process.env.TOKEN);
