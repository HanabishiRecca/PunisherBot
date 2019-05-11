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
client.on('error', console.warn);
client.on('reconnecting', console.log);
client.on('resume', console.log);
client.on('rateLimit', console.warn);

const
    blacklistDb = new Database({ filename: './storage/users.db', autoload: true }),
    serversDb = new Database({ filename: './storage/servers.db', autoload: true });

const
    RemoveMentions = str => str.replace(Discord.MessageMentions.USERS_PATTERN, ''),
    GetMentions = str => str.match(Discord.MessageMentions.USERS_PATTERN);

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
\`addserver id\` - добавить сервер с указанным id в доверенные.
\`removeserver id\` - убрать сервер с указанным id из доверенных.`;

const botCommands = {
    
    //Установка канала для информационных сообщений бота
    channel: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_CHANNELS))
            return;
        
        const
            channel = message.mentions.channels.first(),
            info = await serversDb.findOne({ _id: message.guild.id });
        
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
            
            if(info)
                await serversDb.update({ _id: message.guild.id }, { $set: { channel: channel.id } });
            else
                await serversDb.insert({ _id: message.guild.id, channel: channel.id });
            
            message.reply('канал установлен.');
        } else if(info) {
            await serversDb.update({ _id: message.guild.id }, { $unset: { channel: true } });
            message.reply('канал сброшен.');
        }
        
    },
    
    //Выдача информации о состоянии пользователя
    info: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const
                id = match[0],
                userInfo = await blacklistDb.findOne({ _id: id }),
                server = client.guilds.get(userInfo.server);
            
            if(userInfo)
                message.channel.send(`**Информация**\nПользователь: <@${id}>\nТег: ${(await client.fetchUser(id, false)).tag}\nСервер: ${server ? `${server.name} (${server.id})` : userInfo.server} \nМодератор: <@${userInfo.moder}>\nДата добавления: ${Util.DtString(userInfo.date)}\nПричина: ${userInfo.reason}`);
            else
                message.channel.send(`**Информация**\nПользователь <@${id}> не находится в черном списке.`);
        }
    },
    
    //Выдача списка всех пользователей в черном списке
    blacklist: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const users = await blacklistDb.find({});
        
        await message.channel.send(`**Черный список**\nВсего пользователей: ${users.length}\n*Список будет подгружаться частями, это может занять некоторое время.*`);
        let text = '```py\n';
        for(let i = 0; i < users.length; i++) {
            const
                id = users[i]._id,
                user = await client.fetchUser(id, false),
                add = `<@${id}> → ${user.tag}\n`;
            
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
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const count = parseInt(message.content);
        if(count && (count > 0))
            message.channel.bulkDelete(Math.min(count, 100));
    },
    
    //Выдача статистики
    stats: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_CHANNELS))
            return;
        
        const count = await blacklistDb.count({});
        message.channel.send(`**Статистика**\nПользователей в черном списке: ${count}\nПодключено серверов: ${client.guilds.size}`);
    },
    
    //Выдача списка всех подключенных серверов
    serverlist: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_CHANNELS))
            return;
        
        let msg = `**Список серверов**\nВсего ${client.guilds.size}\n\`\`\`css\n`;
        for(const server of client.guilds.values()) {
            const info = await serversDb.findOne({ _id: server.id });
            msg += `[${(info && info.trusted) ? 'v' : ' '}] | ${server.id} | ${server.name}\n`;
        }
        msg += '```';
        
        message.channel.send(msg);
    },
    
    //Ссылка на приглашение бота
    link: async (message) => {
        message.reply(`<${await client.generateInvite(523334)}>`);
    },
    
    //Справка по боту
    help: async (message) => {
        let text = `**Справка**\n\n${userHelp}\n\n`;
        
        if(message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            text += `${moderHelp}\n\n`;
        
        if(message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_CHANNELS))
            text += `${adminHelp}\n\n`;
        
        if(message.channel.id == config.serviceChannel)
            text += `${serviceHelp}\n\n`;
        
        message.channel.send(text);
    },
    
    //Суперадминские команды, не показываем в справке, работают только в сервисном чате
    //Добавление в черный список
    add: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        const info = await serversDb.findOne({ _id: message.guild.id });
        if(!(info && info.trusted)) {
            message.reply('данный сервер не может добавлять пользователей в черный список.');
            return;
        }
        
        if(!message.mentions.members)
            return;
        
        const
            reason = RemoveMentions(message.content).trim(),
            dt = Date.now();
        
        //Реализуем через ручной поиск упоминаний юзеров, так как пользователь может быть не на сервере.
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const usr = await client.fetchUser(match[0], false);
            if(!usr) {
                message.reply(`пользователь с идентификатором **${match[0]}** не существует.`);
                continue;
            }
            
            if(usr.id == client.user.id) {
                message.reply(':(');
                continue;
            }
            
            //Не трогаем админсостав
            let target;
            try {
                target = await message.guild.fetchMember(usr, false);
            } catch {}
            if(target && target.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES)) {
                message.reply(`нельзя забанить пользователя ${target.toString()}, так как он является представителем администрации сервера.`);
                continue;
            }
            
            message.guild.ban(usr.id, { days: 1, reason: reason });
            
            const userInfo = await blacklistDb.findOne({ _id: usr.id });
            if(userInfo) {
                message.reply(`пользователь ${usr.toString()} уже находится в черном списке.`);
            } else {
                await blacklistDb.insert({ _id: usr.id, server: message.guild.id, moder: message.author.id, date: dt, reason: reason });
                const msg = `Модератор ${message.member.toString()} добавил пользователя ${usr.toString()} в черный список.${reason ? `\nПричина: ${reason}` : ''}`;
                SendInfo(message.guild, msg);
                ServiceLog(message.guild, msg);
                NotifyAllServers(message.guild.id, usr.id, true);
            }
        }
    },
    
    //Удаление из черного списка
    remove: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        const info = await serversDb.findOne({ _id: message.guild.id });
        if(!(info && info.trusted)) {
            message.reply('данный сервер не может убирать пользователей из черного списка.');
            return;
        }
        
        //Реализуем через ручной поиск упоминаний юзеров, так как пользователь может быть не на сервере.
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        const reason = RemoveMentions(message.content).trim();
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const
                id = match[0],
                userInfo = await blacklistDb.findOne({ _id: id });
            
            if(userInfo) {
                await blacklistDb.remove({ _id: id });
                try {
                    await message.guild.unban(id, reason);
                } catch {}
                const msg = `Модератор ${message.member.toString()} убрал пользователя <@${id}> из черного списка.${reason ? `\nПричина: ${reason}` : ''}`;
                SendInfo(message.guild, msg);
                ServiceLog(message.guild, msg);
                NotifyAllServers(message.guild.id, id, false);
            } else {
                message.reply(`пользователь <@${id}> не находится в черном списке.`);
            }
        }
    },
    
    //Добавление доверенного сервера
    addserver: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        const server = client.guilds.get(message.content);
        if(!server) {
            message.reply('не удалось найти подключенный сервер с указанным идентификатором.');
            return;
        }
        
        const info = await serversDb.findOne({ _id: server.id });
        if(info) {
            if(info.trusted) {
                message.reply(`сервер уже находится в списке доверенных.`);
                return;
            }
            await serversDb.update({ _id: server.id }, { $set: { trusted: true } });
        } else {
            await serversDb.insert({ _id: server.id, trusted: true });
        }
        message.reply(`сервер **${server.name}** (${server.id}) добавлен в список доверенных.`);
    },
    
    //Удаление доверенного сервера
    removeserver: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        const info = await serversDb.findOne({ _id: message.content });
        if(!(info && info.trusted)) {
            message.reply(`сервер отсутствует в списке доверенных.`);
            return;
        }
        
        await serversDb.update({ _id: message.content }, { $unset: { trusted: true } });
        
        const server = client.guilds.get(message.content);
        if(server)
            message.reply(`сервер ${server ? `${server.name} (${server.id})` : message.content} удален из списка доверенных.`);
    },
    
};

//Проверка пользователя в черном списке
async function CheckBanned(member) {
    //Не трогаем админсостав
    if(member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
        return false;
    
    const userInfo = await blacklistDb.findOne({ _id: member.id });
    if(!userInfo)
        return false;
    
    await member.ban({ days: 1, reason: 'Автоматический бан' });
    const msg = `Пользователь ${member.toString()} находится в черном списке! Выдан автоматический бан.`;
    SendInfo(member.guild, msg);
    ServiceLog(member.guild, msg);
    
    return true;
}

const suspiciousUsers = new Map();
async function CheckSpam(message) {
    //Не трогаем админсостав
    if(message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
        return false;
    
    const code = Util.GetInviteCode(message.content);
    if(!code)
        return false;
    
    let invite;
    try {
        invite = await client.rest.methods.getInvite(code);
    } catch {}
    
    if(invite) {
        if(invite.guild.id == message.guild.id)
            return false;
        
        if(client.guilds.has(invite.guild.id)) {
            const info = await serversDb.findOne({ _id: invite.guild.id });
            if(info && info.trusted)
                return false;
        }
    }
    
    const now = Date.now();
    let resident = false;
    for(const server of client.guilds.values()) {
        if(server.id == message.guild.id)
            continue;
        
        try {
            if((await server.fetchMember(message.author.id)).joinedTimestamp < now - config.banJoinPeriod) {
                resident = true;
                break;
            }
        } catch {}
    }
    
    if(resident) {
        if(suspiciousUsers.has(message.author.id)) {
            await message.delete();
            message.author.send(`Обнаружено злоупотребление инвайтами. Сообщение удалено.`);
            Notify(message.guild, `Злоупотребление инвайтами от пользователя ${message.author.toString()}. Сообщение удалено, пользователю выслано предупреждение.\n\n**Содержимое сообщения**\`\`\`${message.content}\`\`\``);
            clearTimeout(suspiciousUsers.get(message.author.id));
        }
        suspiciousUsers.set(message.author.id, setTimeout(suspiciousUsers.delete, config.suspiciousTimeout, message.author.id));
    } else {
        if(suspiciousUsers.has(message.author.id)) {
            await blacklistDb.insert({ _id: message.author.id, server: message.guild.id, moder: client.user.id, date: Date.now(), reason: 'Автоматически: сторонний пользователь, спам сторонним инвайтом' });
            await message.member.ban({ days: 1, reason: 'Автоматический бан' });
            Notify(`Пользователь ${message.member.toString()} автоматически добавлен в черный список.\n\n**Содержимое сообщения**\`\`\`${message.content}\`\`\``);
            NotifyAllServers(message.guild.id, message.author.id, true);
            suspiciousUsers.delete(message.author.id);
        } else {
            await message.delete();
            suspiciousUsers.set(message.author.id, 0);
            message.author.send(`Обнаружена попытка спама на сервере \`${message.guild.name}\`. Сообщение удалено. Повторная попытка спама приведет к бану.`);
            Notify(message.guild, `Сторонний пользователь ${message.author.toString()} разместил стороннее приглашение. Сообщение удалено, пользователю выслано предупреждение. Повторная попытка приведет к бану.\n\n**Содержимое сообщения**\`\`\`${message.content}\`\`\``);
        }
    }
    
    return true;
}

async function SendInfo(server, msg) {
    const info = await serversDb.findOne({ _id: server.id });
    if(info && info.channel)
        client.channels.get(info.channel).send(msg);
}

async function ServiceLog(server, msg) {
    client.channels.get(config.serviceChannel).send(`**Сервер:** ${server.name} (${server.id})\n**Событие:**\n${msg}`);
}

async function Notify(server, msg) {
    SendInfo(server, msg);
    ServiceLog(server, msg);
}

async function NotifyServer(server, userId, mode) {
    if(mode) {
        let member;
        try {
            member = await server.fetchMember(userId, false);
        } catch {}
        if(member && member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES)) {
            SendInfo(server, `Попытка добавления в черный список представителя администрации ${member.toString()} на другом сервере. Рекомендуется срочно обратиться к администрации бота!`);
            ServiceLog(server, `Представитель администрации ${member.toString()} добавлен в черный список. Рекомендуется немедленно разобраться!`);
            return;
        }
        try {
            await server.ban(userId, { days: 1, reason: 'Автоматический бан' });
        } catch {}
        SendInfo(server, `Пользователь <@${userId}> был добавлен в черный список на другом сервере. Выдан автоматический бан.`);
    } else {
        try {
            await server.unban(userId);
        } catch {}
        SendInfo(server, `Пользователь <@${userId}> был убран из черного списка на другом сервере. Бан снят автоматически.`);
    }
}

async function NotifyAllServers(thisServerId, userId, mode) {
    for(const server of client.guilds.values())
        if(server.id != thisServerId)
            NotifyServer(server, userId, mode);
}

client.on('guildMemberAdd', CheckBanned);

client.on('guildCreate', async (server) => {
    client.channels.get(config.serviceChannel).send(`**Подключен новый сервер!**\n${server.name} (${server.id})`);
});
client.on('guildDelete', async (server) => {
    client.channels.get(config.serviceChannel).send(`**Сервер отключен**\n${server.name} (${server.id})`);
    //serversDb.remove({ _id: server.id });
});

client.on('message', async (message) => {
    if(!(message.content && message.member))
        return;
    
    if(message.author.id == client.user.id)
        return;
    
    if(((message.member.joinedTimestamp > Date.now() - config.banJoinPeriod) && await CheckBanned(message.member)) || await CheckSpam(message))
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
});

client.login(process.env.TOKEN);
