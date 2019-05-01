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

const client = new Discord.Client();
client.on('disconnect', Shutdown);
client.on('error', console.warn);
client.on('reconnecting', console.log);
client.on('resume', console.log);
client.on('rateLimit', console.warn);

const blacklistDb = new Database({ filename: './storage/users.db', autoload: true });

const
    RemoveMentions = str => str.replace(Discord.MessageMentions.USERS_PATTERN, ''),
    GetMentions = str => str.match(Discord.MessageMentions.USERS_PATTERN);

const helpText = `**Справка**

Префикс: **${config.prefix}**

Команды:
**add** <@user> [reason] - добавить указанных пользователей в черный список с указанием причины.
**remove** <@user> - убрать указанных пользователей из черного списка.
**info** <@user> - информация об указанном пользователе.
**cleanup** <count> - удалить указанное количество последних сообщений на канале. За один раз можно удалить максимум 100 сообщений.
**stats** - статистика.
**help** - показать данное справочное сообщение.

Параметры:
<param> - обязательный параметр.
[param] - необязательный параметр.`;

const botCommands = {
    
    //Добавление в черный список
    add: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.BAN_MEMBERS))
            return;
        
        if(!message.mentions.members)
            return;
        
        const
            reason = RemoveMentions(message.content).trim(),
            dt = Date.now();
        
        //Реализуем через members. Защита от потенциальной возможности добавить людей, не находящихся на данном сервере.
        for(const target of message.mentions.members.values()) {
            //Не трогаем админсостав
            if(target.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
                continue;
            
            target.ban(reason);
            
            const userInfo = await blacklistDb.findOne({ _id: target.id });
            if(userInfo) {
                message.reply(`пользователь ${target.toString()} уже находится в черном списке.`);
            } else {
                await blacklistDb.insert({ _id: target.id, date: dt, reason: reason });
                message.guild.systemChannel.send(`Модератор ${message.member.toString()} добавил пользователя ${target.toString()} в черный список.${reason ? `\nПричина: ${reason}` : ''}`);
            }
        }
    },
    
    //Удаление из черного списка
    remove: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.BAN_MEMBERS))
            return;
        
        //Реализуем через ручной поиск упоминаний юзеров, так как пользователь может быть не на сервере.
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        const reason = RemoveMentions(message.content).trim();
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const id = match[0];
            message.guild.unban(id, reason);
            
            const userInfo = await blacklistDb.findOne({ _id: id });
            if(userInfo) {
                await blacklistDb.remove({ _id: id });
                message.guild.systemChannel.send(`Модератор ${message.member.toString()} убрал пользователя <@${id}> из черного списка.${reason ? `\nПричина: ${reason}` : ''}`);
            } else {
                message.reply(`пользователь <@${id}> не находится в черном списке.`);
            }
        }
    },
    
    //Выдача информации о состоянии пользователя
    info: async (message) => {
        //Предположительно пока даем получать информацию только модераторам
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
                userInfo = await blacklistDb.findOne({ _id: id });
            
            if(userInfo)
                message.reply(`пользователь <@${id}> находится в черном списке.\nДата добавления: ${Util.DtString(userInfo.date)}\nПричина: ${userInfo.reason}`);
            else
                message.reply(`пользователь <@${id}> не находится в черном списке.`);
        }
    },
    
    //Удаление сообщений
    cleanup: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const count = parseInt(message.content);
        if(count && (count > 0))
            message.channel.bulkDelete(count);
    },
    
    //Выдача статистики
    stats: async (message) => {
        //Предположительно пока даем получать информацию только модераторам
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const count = await blacklistDb.count({});
        message.channel.send(`**Статистика**\nВсего пользователей в черном списке: ${count}\nПодключено серверов: ${client.guilds.size}`);
    },
    
    //Справка по боту
    help: async (message) => {
        //Предположительно пока даем получать информацию только модераторам
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        message.channel.send(helpText);
    },
    
};

//Проверка пользователя в черном списке
async function CheckBanned(member) {
    //Не трогаем админсостав
    if(member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
        return false;
    
    const userInfo = await blacklistDb.findOne({ _id: member.id });
    if(userInfo) {
        member.guild.systemChannel.send(`Пользователь ${member.toString()} находится в черном списке!`);
        
        //Попытка автоматически найти роль с ограничением
        const blacklistRole = member.guild.roles.find(role => !role.hasPermission(Discord.Permissions.FLAGS.SEND_MESSAGES));
        if(blacklistRole) {
            await member.addRole(blacklistRole);
            member.guild.systemChannel.send(`В целях безопасности пользователю ${member.toString()} выдана роль ${blacklistRole.toString()}.`);
        } else {
            member.guild.systemChannel.send('Не найдена роль для ограничения отправки сообщений, нечего выдавать :(');
        }
        
        return true;
    }
    return false;
}

client.on('guildMemberAdd', CheckBanned);

client.on('message', async (message) => {
    if(!(message.content && message.member))
        return;
    
    if(message.author.id == client.user.id)
        return;
    
    //Проверять черный список на каждое сообщение может плохо влиять на производительность, нужно тестировать
    if(await CheckBanned(message.member))
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
