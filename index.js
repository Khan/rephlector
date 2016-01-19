const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const moment = require('moment');
const csv = require('fast-csv');
const meow = require('meow');


function getUserHome() {
    return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

const arcrcPath = path.join(getUserHome(), '.arcrc');
const arcrc = JSON.parse(fs.readFileSync(arcrcPath, 'utf8'));

const conduitHost = Object.keys(arcrc.hosts)[0];
const accessToken = arcrc.hosts[conduitHost].token;

// TODO(kevinb): use querydiffs to get a sense of how much churn there is
// can also get the created/modified dates for each diff which is important
// for determine how much time was actually spent on development
// differential.querydiffs

function buildQueryString(params) {
    return Object.entries(params)
        .map(entry => `${entry[0]}=${entry[1]}`)
        .join('&');
}

async function whoami() {
    const whoamiUrl = `${conduitHost}user.whoami`;
    const options = {
        method: 'POST',
        body: `api.token=${accessToken}`,
    };

    const response = await fetch(whoamiUrl, options);
    const body = await response.json();
    return body.result;
}

async function getRevision(authorPHID, params) {
    const queryUrl = `${conduitHost}differential.query`;
    const options = {
        method: 'POST',
        body: buildQueryString({
            ...params,
            'api.token': accessToken,
            'authors[0]': authorPHID,
        }),
    };

    const response = await fetch(queryUrl, options);
    const body = await response.json();
    return body.result;
}

async function getDiffs(revisionId) {
    const url = `${conduitHost}differential.querydiffs`;
    const options = {
        method: 'POST',
        body: buildQueryString({
            'api.token': accessToken,
            'revisionIDs[0]': revisionId,
        }),
    };

    const response = await fetch(url, options);
    const body = await response.json();
    return body.result;
}

async function getCommitPaths(revisionId) {
    const queryUrl = `${conduitHost}differential.getcommitpaths`;
    const options = {
        method: 'POST',
        body: `api.token=${accessToken}&revision_id=${revisionId}`,
    };

    const response = await fetch(queryUrl, options);
    const body = await response.json();
    return body.result;
}

const users = {};
const repos = {};

async function userQuery(userPHID) {
    const queryUrl = `${conduitHost}user.query`;
    const options = {
        method: 'POST',
        body: `api.token=${accessToken}&phids[0]=${userPHID}`,
    };

    const response = await fetch(queryUrl, options);
    const body = await response.json();
    return body.result[0];
}

async function getUser(phid) {
    if (!users[phid]) {
        users[phid] = await userQuery(phid);
    }
    return users[phid];
}

async function repoQuery(repoPHID) {
    const queryUrl = `${conduitHost}repository.query`;
    const options = {
        method: 'POST',
        body: `api.token=${accessToken}&phids[0]=${repoPHID}`,
    };

    const response = await fetch(queryUrl, options);
    const body = await response.json();
    return body.result[0];
}

async function getRepo(phid) {
    if (!repos[phid]) {
        repos[phid] = await repoQuery(phid);
    }
    return repos[phid];
}

// TODO(kevinb): take cli switches to control the date ranges
async function main() {
    const me = await whoami();

    users[me.phid] = me;

    const revisions = await getRevision(me.phid, cli.flags);

    const csvStream = csv.createWriteStream({ headers: true });
    const writableStream = fs.createWriteStream(filename);

    csvStream.pipe(writableStream);

    let current = 1;
    const total = revisions.length;

    for (const rev of revisions) {
        const row = {};

        row.title = rev.title;
        row.uri = rev.uri;

        // parallelize all of the requests
        const [diffs, repo, commitPaths, ...reviewers] = await Promise.all([
            getDiffs(rev.id),
            getRepo(rev.repositoryPHID),
            getCommitPaths(rev.id),
            ...rev.reviewers.map(getUser),
        ]);

        const firstDiff = moment(
            Math.min(...Object.values(diffs).map(d => d.dateCreated)) * 1000);
        const lastDiff = moment(
            Math.max(...Object.values(diffs).map(d => d.dateCreated)) * 1000);

        row.firstDiff = firstDiff.format('YYYY-MM-DD');
        row.lastDiff = lastDiff.format('YYYY-MM-DD');
        row.devTime = lastDiff.diff(firstDiff, 'd');

        const created = moment(rev.dateCreated * 1000);
        const modified = moment(rev.dateModified * 1000);

        row.created = created.format('YYYY-MM-DD');
        row.modified = modified.format('YYYY-MM-DD');
        row.openFor = modified.diff(created, 'd');
        row.status = rev.statusName;
        row.reviewers = reviewers.map(reviewer => reviewer.userName);
        row.diffCount = rev.diffs.length;
        row.lineCount = rev.lineCount;

        if (repo) {
            row.repo = repo.name;
        }

        row.commitPaths = commitPaths;

        csvStream.write(row);

        console.log(`wrote ${current++} of ${total}: ${rev.title}`);
    }

    csvStream.end();
}

const usage = `
    Usage
      $ node main.js <output>

    Options
      --limit

    Examples
      $ node main.js reviews.csv --limit 2
`;

const cli = meow(usage, {});

if (cli.input.length !== 1) {
    console.log(usage);
    process.exit(1);
}

const filename = cli.input[0];

main();
