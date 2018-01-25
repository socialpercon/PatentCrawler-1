//services
const DBService = require('./src/services/dbService');
const OCRService = require('./src/services/ocrService');
const PatentCrawler = require('./src/services/patentCrawler');
//uitls
const patentUtil = require('./src/utils/patentUtil');
const imageUtil = require('./src/utils/imageUtil');
const ipUtil = require("./src/utils/ipUtil");
//models
const FutureFee = require('./src/models/futureFee');

const dbService = new DBService();
const ocrService = new OCRService();

let patentCrawler = null;
let token = null;

//生成所有的任务
async function reGenerateTasks() {
    await dbService.connectIptp();
    await dbService.connectLocal();
    await dbService.deleteAllPatentTasks();
    let colleges = await dbService.getAllColleges();
    for (let i = 0; i < colleges.length; i++) {
        let college = colleges[i];
        let patents = await dbService.getPatentsOfCollege(college.storageId);
        console.log(`${college.name}: ${patents.length} tasks`)
        for (let j = 0; j < patents.length; j++) {
            let patent = patents[j];
            await dbService.createPatentTask(patent);
        }
    }
}

//执行任务
async function startCrawling() {
    const tasks = await dbService.getAllPatentTasks();
    for (let i = 0; i < tasks.length; i++) {
        let task = tasks[i];
        let applyNumber = patentUtil.getPatentApplyNumber(task.patentApplyNumber);
        let feeResult = null;
        try {
            feeResult = await patentCrawler.getFeeOfPatent(applyNumber, token)
        } catch (error) {
            const isDetail = await patentCrawler.isInPatentDetailPage();
            if (isDetail) {
                --i;
                continue;
            } else {
                const isExpire = await patentCrawler.isInExpirePage();
                if (isExpire) {
                    throw "Token Expired!!!";
                }
            }
        }
        if (!feeResult) {
            --i;
            continue;
        }
        const futureFees = feeResult.map((data, index) => {
            return new FutureFee(data.feeType, data.feeAmount, data.deadline);
        });
        await dbService.deleteFutureFeeOfPatent(task.patentId);
        const insertResult = await dbService.createPatentFutureFee(task.patentId, task.patentApplyNumber, task.patentTitle, futureFees);
        const updateResult = await dbService.donePatentTask(task.id);
        console.log(task.id);
    }
    console.log("All tasks done!!!");
}

//破解进入查询页面, 成功返回true，失败则不断重试
async function breakAuth() {
    var clipRect = {
        x: 231,
        y: 289,
        width: 50,
        height: 26
    };
    try {
        await patentCrawler.getAuthImage(clipRect);
    } catch (error) {
        return false;
    }
    // const imgInfo = await imageUtil.imageDenoiseAsync("./assets/authCode.png");
    // console.log(imgInfo);
    const resultStr = await ocrService.getVerifyCodeResult();
    const result = JSON.parse(resultStr);
    console.log(resultStr);
    const wordsResult = result["words_result"];
    if (!wordsResult || wordsResult.length === 0) {
        return false;
    }
    let codeText = result.words_result[0].words;
    const pattern = /.*(\d).*([+-]).*(\d)/;
    const match = codeText.match(pattern);
    if (match) {
        let num1 = Number(match[1]);
        let operator = match[2];
        let num2 = Number(match[3]);
        let answer = (operator === "+" ? num1 + num2 : num1 - num2).toString();
        try {
            let tokenResult = await patentCrawler.getTokenWithAuthCode(answer);
            token = tokenResult;
            return true;
        } catch (error) {
            console.log(`验证失败：${error}`);
            return false;
        }
    } else {
        return false;
    }
}

//主函数
async function main() {
    let allTasksSuccess = false;
    await dbService.connectLocal();
    while (!allTasksSuccess) {
        const ip = await ipUtil.getIP();
        if (patentCrawler) {
            await patentCrawler.end();
        }
        patentCrawler = new PatentCrawler(ip);
        const breakSuccess = await breakAuth();
        if (breakSuccess) {
            try {
                await startCrawling();
                allTasksSuccess = true;
            } catch (err) {
                console.log(err);
            }
        }
    }
}

main();
