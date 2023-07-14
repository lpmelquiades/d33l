const express = require('express');
const bodyParser = require('body-parser');
const {sequelize} = require('./model')
const {getProfile} = require('./middleware/getProfile')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)


app.get('/contracts/:id',getProfile ,async (req, res) =>{
    let {Contract} = req.app.get('models')
    let {id} = req.params

    let exp = null
    if (req.profile.type === 'client') {
        exp = {ClientId: req.profile.id}
    }
    if (req.profile.type === 'contractor') {
        exp = {ContractorId: req.profile.id}
    }

    if (!exp) return res.status(404).end()
    let contract = await Contract.findOne({ where: { id: id, ...exp } })
    if (!contract) return res.status(404).end()
    return res.json(contract)
})

app.get('/contracts',getProfile ,async (req, res) =>{
    let {Contract} = req.app.get('models')

    let exp = null
    if (req.profile.type === 'client') {
        exp = {ClientId: req.profile.id}
    }
    if (req.profile.type === 'contractor') {
        exp = {ContractorId: req.profile.id}
    }

    if (!exp) return res.json([])
    let contracts = await Contract.findAll({where: { ...exp}})
    return res.json(contracts)
})

app.get('/jobs/unpaid',getProfile ,async (req, res) =>{
    let {Contract, Job} = req.app.get('models')

    let exp = null
    if (req.profile.type === 'client') {
        exp = {ClientId: req.profile.id}
    }
    if (req.profile.type === 'contractor') {
        exp = {ContractorId: req.profile.id}
    }

    if (!exp) return res.json([])

    let contracts = await Contract.findAll({
        where: { ...exp, status: ['new', 'in_progress']},
        include: [{model: Job, required: true, where: {paid: null}}]            
    })

    let jobs = contracts.reduce(
        (accumulator, contract) => accumulator.concat(contract.Jobs),
        []
    )

    return res.json(jobs)
})

app.post('/jobs/:job_id/pay',getProfile ,async (req, res) =>{
    
    if (req.profile.type !== 'client') return res.status(403).end()
    
    let {Contract, Job, Profile} = req.app.get('models')
    let {job_id} = req.params
    
    let job = await Job.findOne({
        where: {id: job_id},
        include: [
            {
                model: Contract, required: true, include: [
                    {model: Profile, as: 'Contractor', required: true},
                    {model: Profile, as: 'Client', required: true, where: {id: req.profile.id}}        
                ]
            }
        ]            
    })

    if (job === null) return res.status(404).end()
    if (job.paid === true) return res.json(job)
    if (job.Contract.Client.balance < job.price) return res.status(500).json({message: 'insufficient funds: balance'})


    let t = await sequelize.transaction();

    let clientBalance = job.Contract.Client.update({
        balance: job.Contract.Client.balance - job.price,
    }, { transaction: t });

    let contractorBalance = job.Contract.Contractor.update({
        balance: job.Contract.Contractor.balance + job.price,
    }, { transaction: t });

    let jobPaid = job.update({
        paid: true
    }, { transaction: t });

    let toBeSettleded = [clientBalance, contractorBalance, jobPaid]

    let results = await Promise.allSettled(toBeSettleded)
    let fulfilledOnes = results.filter(result => result.status === 'fulfilled')

    if (fulfilledOnes.length !== results.length) {
        await t.rollback()
        return res.status(500).json({message: 'something bad is not good'})
    }

    await t.commit()
    return res.json(job)
})

app.post('/balances/deposit/:userId',getProfile ,async (req, res) =>{
    
    if (req.profile.type !== 'client') return res.status(403).end()
    if (req.body.amount === null || (typeof req.body.amount) !== 'number') return res.status(422).end()
    if (req.body.amount < 1) return res.status(422).end()
    if (req.body.amount > req.profile.balance) return res.status(500).json({message: 'insufficient funds: balance'})
    
    let {Profile, Job, Contract} = req.app.get('models')

    let {userId} = req.params
    let targetUser = await Profile.findOne({where: {id: userId, type: 'client'}})

    if (targetUser === null) return res.status(422).end()

    if (req.profile.id === targetUser.id) return res.status(403).end()

    let notPaidCalc = await Job.findAll({
        where: {paid: null},
        include: [
            {
                model: Contract, required: true, include: [
                    {model: Profile, as: 'Client', required: true, where: {id: req.profile.id}}        
                ]
            }
        ],
        raw: true,
        attributes: [[sequelize.fn('sum', sequelize.col('price')), 'total']],
    })

    let total = (
        notPaidCalc === null
        || notPaidCalc === []
        || notPaidCalc[0] === null
        || notPaidCalc[0].total === null
        || notPaidCalc[0].total === 0
    ) ? 0 : notPaidCalc[0].total

    if (req.body.amount > (total * 0.25)
        || (req.profile.balance - req.body.amount) < (total * 0.25)
    ) return res.status(500).json({message: 'insufficient funds: due'})

    console.log(notPaidCalc[0].total * 0.25)

    let t = await sequelize.transaction();

    let sourceBalance = req.profile.update({
        balance: req.profile.balance - req.body.amount,
    }, { transaction: t });

    let targetBalance = targetUser.update({
        balance: targetUser.balance + req.body.amount,
    }, { transaction: t });

    let toBeSettleded = [sourceBalance, targetBalance]

    let results = await Promise.allSettled(toBeSettleded)
    let fulfilledOnes = results.filter(result => result.status === 'fulfilled')

    if (fulfilledOnes.length !== results.length) {
        await t.rollback()
        return res.status(500).json({message: 'something bad is not good'})
    }

    await t.commit()

    return res.json({due: (notPaidCalc[0]?.total ?? 0) , source: req.profile, target: targetUser})
})

app.get('/jobs',getProfile ,async (req, res) =>{
    let {Contract, Job} = req.app.get('models')

    let contracts = await Contract.findAll({
        include: [{model: Job, required: true, where: {paid: null}}]            
    })

    return res.json(contracts)
})


module.exports = app;
