const Koa = require('koa');
const Router = require('koa-router');
const BodyParser = require('koa-bodyparser');
const Request = require('request-promise-native');
const Redis = require('redis');

const app = new Koa();
const router = new Router();
const redisClient = Redis.createClient({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD
});
const defaultLanguageCode = "de";

router.get("/probe", ctx => ctx.status = 200); // Liveness / Readiness Probe

router.post("/v1/events/address-update", async ctx => {
    let body = ctx.request.body;
    if (body && body.address && body.address.id && body.address.countryName) {
        let originalCountryName = body.address.countryName;
        redisWrapper(originalCountryName);
        let canonicalCountryName = await getCanonicalCountryName(originalCountryName);
        if (canonicalCountryName !== originalCountryName) {
            Request.put(`${process.env.GATEWAY_URL}/v1/address/${body.address.id}`, {json: true, body: {countryName: canonicalCountryName}});
            console.log(canonicalCountryName);
        }
        ctx.status = 200; // Success Status Code
        return;
    }
    ctx.status = 400; // Bad Request Status Code
});

app.use(BodyParser()).use(router.routes()).use(router.allowedMethods());
const server = app.listen(parseInt(process.env.PORT));

process.on("SIGTERM", () => {
    server.close();
    redisClient.quit();
});

async function redisWrapper(countryName) {
    return new Promise((resolve, reject) => {
        redisClient.get(countryName, async (err, value) => {
            if (err) {
                reject(err);
                return;
            }
            if (value) {
                console.log(`${countryName} => ${value} taken from Redis`);
                resolve(value);
                return;
            }
            getCanonicalCountryName(countryName).then(canonicalCountryName => {
                redisClient.set(countryName, canonicalCountryName);
                resolve(canonicalCountryName);
            });
        });
    });
}

async function getCanonicalCountryName(countryName) {
    let countryUppercaseName = countryName.toUpperCase();
    let countryList = await Request.get(process.env.COUNTRYLIST_ENDPOINT, {json: true});
    
    let matchingCountries = countryList.filter((country) => {
        if (country.name.toUpperCase() === countryUppercaseName)
            return true;

        if (country.altSpellings.some((countrySpelling) => {
            if (countrySpelling.toUpperCase() === countryUppercaseName)
                return true;
        }))
            return true;

        if (Object.keys(country.translations).some((translationKey) => {
            let translation = country.translations[translationKey];
            if (translation && translation.toUpperCase() === countryUppercaseName)
                return true;
        }))
            return true;
    });

    if (matchingCountries.length === 1) {
        return matchingCountries[0].translations[defaultLanguageCode] || matchingCountries[0].name;
    }
    return countryName;
}