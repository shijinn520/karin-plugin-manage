import { searchData } from '../../../core/database/index.js';
export default async (fastify) => {
    /**
     * GET请求
     */
    // 默认页面
    fastify.get('/', async (_request, reply) => {
        return reply.sendFile('page/database/index.html');
    });
    /**
     * POST请求
     */
    // 获取database数据
    fastify.post('/SearchData', async (request, reply) => {
        const { pattern = '*', page = 1, count = 10 } = request.body;
        try {
            const data = await searchData(pattern, page, count);
            return reply.send({ status: 'success', data: data });
        }
        catch (error) {
            return reply.status(400).send({ status: 'error', message: error.toString() });
        }
    });
};
